mod registry;
mod schema;

use self::{
    registry::{
        ConnectionRegistry, DeviceDescriptor, FeatureDescriptor, TelemetryKind, TelemetryValue,
        VibrateTarget,
    },
    schema::{
        validate_intensity, validate_schema, DeviceRequest, FenceRequest, GateError, GlobalAck,
        GlobalRequest, HardwareState, InitializeRequest, InitializeResponse, NativeEvent,
        OperationAck, ScanAck, StopFeatureRequest, VibrateRequest, MAX_STEP_COUNT, SCHEMA_VERSION,
    },
};
use crate::scan_coordinator::{
    claim_dg_plugin_blec_scanner, release_dg_plugin_blec_scanner, DgScannerClaim,
    DgScannerReleaseRequest, ScanCoordinator, ScannerCoordinationError, ScannerLease, ScannerOwner,
};
use buttplug_client::{
    device::{ClientDeviceCommandValue, ClientDeviceOutputCommand},
    ButtplugClient, ButtplugClientDevice, ButtplugClientEvent,
};
use buttplug_client_in_process::in_process_client;
use buttplug_core::message::{InputCommandType, InputType, OutputType};
use futures::StreamExt;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::Channel, State};

const TELEMETRY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
struct GateState {
    shared: Arc<GateShared>,
}

#[derive(Default)]
struct GateShared {
    initialization: tokio::sync::Mutex<()>,
    topology: tokio::sync::Mutex<()>,
    output: tokio::sync::Mutex<()>,
    inner: Mutex<GateInner>,
}

#[derive(Default)]
struct GateInner {
    session: Option<GateSession>,
}

struct GateSession {
    id: String,
    topology_generation: u64,
    safety_generation: u64,
    client: Arc<ButtplugClient>,
    scanning: bool,
    scan_transition: bool,
    scanner_lease: Option<ScannerLease>,
    output_blocked: bool,
    output_faulted: bool,
    terminal: bool,
    closing: bool,
    terminal_event_sent: bool,
    registry: ConnectionRegistry,
    events: Channel<NativeEvent>,
}

#[tauri::command]
fn dg_blec_claim_scanner(
    coordinator: State<'_, ScanCoordinator>,
) -> Result<DgScannerClaim, ScannerCoordinationError> {
    claim_dg_plugin_blec_scanner(&coordinator)
}

#[tauri::command]
fn dg_blec_release_scanner(
    coordinator: State<'_, ScanCoordinator>,
    request: DgScannerReleaseRequest,
) -> Result<(), ScannerCoordinationError> {
    release_dg_plugin_blec_scanner(&coordinator, request)
}

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let state = GateState::default();
    let coordinator = ScanCoordinator::default();

    #[cfg(target_os = "android")]
    crate::buttplug_android::install_lifecycle_stop_handler({
        let state = state.clone();
        let coordinator = coordinator.clone();
        move || request_lifecycle_stop(state.clone(), coordinator.clone())
    });

    builder
        .manage(state)
        .manage(coordinator)
        .invoke_handler(tauri::generate_handler![
            experimental_buttplug_initialize,
            experimental_buttplug_start_scan,
            experimental_buttplug_stop_scan,
            experimental_buttplug_list_devices,
            experimental_buttplug_disconnect,
            experimental_buttplug_vibrate,
            experimental_buttplug_stop_feature,
            experimental_buttplug_stop_all,
            experimental_buttplug_close,
            dg_blec_claim_scanner,
            dg_blec_release_scanner,
        ])
}

#[tauri::command]
async fn experimental_buttplug_initialize(
    state: State<'_, GateState>,
    coordinator: State<'_, ScanCoordinator>,
    request: InitializeRequest,
    on_event: Channel<NativeEvent>,
) -> Result<InitializeResponse, GateError> {
    validate_schema(request.schema_version)?;
    let _initialization = state.shared.initialization.lock().await;

    if state
        .shared
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .session
        .is_some()
    {
        return Err(GateError::new(
            "session_in_use",
            "the native backend already has an open session",
        ));
    }

    #[cfg(target_os = "android")]
    if !crate::buttplug_android::ready() {
        return Err(GateError::new(
            "native_not_ready",
            "btleplug Android JNI initialization is unavailable",
        ));
    }

    // The feature set enables only the embedded btleplug manager. There are no
    // websocket, serial, HID, XInput, Lovense-service, or raw-message surfaces.
    let client = Arc::new(in_process_client("0xNuller embedded device backend").await);
    let mut event_stream = client.event_stream();
    let session_id = uuid::Uuid::new_v4().to_string();
    state
        .shared
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .session = Some(GateSession {
        id: session_id.clone(),
        topology_generation: 0,
        safety_generation: 0,
        client: client.clone(),
        scanning: false,
        scan_transition: false,
        scanner_lease: None,
        output_blocked: false,
        output_faulted: false,
        terminal: false,
        closing: false,
        terminal_event_sent: false,
        registry: ConnectionRegistry::default(),
        events: on_event,
    });

    let event_state = state.inner().clone();
    let event_coordinator = coordinator.inner().clone();
    let event_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = event_stream.next().await {
            handle_client_event(&event_state, &event_coordinator, &event_session_id, event).await;
        }
        handle_event_stream_end(&event_state, &event_coordinator, &event_session_id);
    });

    if let Err(error) = synchronize_topology(&state, &session_id).await {
        fail_session(&state, &session_id, "topology-unavailable").await;
        return Err(error);
    }

    session_response(&state, &session_id)
}

#[tauri::command]
async fn experimental_buttplug_start_scan(
    state: State<'_, GateState>,
    coordinator: State<'_, ScanCoordinator>,
    request: FenceRequest,
) -> Result<ScanAck, GateError> {
    validate_schema(request.schema_version)?;
    let (client, session_id, topology_generation, safety_generation) = {
        let mut inner = lock_inner(&state);
        let session = checked_fence_mut(&mut inner, &request)?;
        ensure_operational(session)?;
        if session.scan_transition {
            return Err(GateError::new(
                "scan_transition",
                "a scan transition is already in progress",
            ));
        }
        if session.scanning {
            return Ok(scan_ack(session));
        }
        let scanner_lease = coordinator.try_claim(ScannerOwner::Buttplug).map_err(|_| {
            GateError::new(
                "scanner_in_use",
                "the BLE scanner is owned by another backend",
            )
        })?;
        session.scan_transition = true;
        session.scanner_lease = Some(scanner_lease);
        (
            session.client.clone(),
            session.id.clone(),
            session.topology_generation,
            session.safety_generation,
        )
    };

    match client.start_scanning().await {
        Ok(()) => {
            let mut inner = lock_inner(&state);
            let session = inner.session.as_mut().ok_or_else(not_initialized)?;
            validate_generation(session, &session_id, topology_generation, safety_generation)?;
            session.scanning = true;
            session.scan_transition = false;
            Ok(scan_ack(session))
        }
        Err(error) => {
            log::error!("embedded Buttplug scan start failed: {error}");
            release_session_scanner_lease(&state, &coordinator, &session_id);
            clear_scan_transition(&state, &session_id, topology_generation, safety_generation);
            Err(GateError::new(
                "scan_start_failed",
                "the native scanner did not start",
            ))
        }
    }
}

#[tauri::command]
async fn experimental_buttplug_stop_scan(
    state: State<'_, GateState>,
    coordinator: State<'_, ScanCoordinator>,
    request: FenceRequest,
) -> Result<ScanAck, GateError> {
    validate_schema(request.schema_version)?;
    let (client, scanner_lease, session_id, topology_generation, safety_generation) = {
        let mut inner = lock_inner(&state);
        let session = checked_fence_mut(&mut inner, &request)?;
        if session.scan_transition {
            return Err(GateError::new(
                "scan_transition",
                "a scan transition is already in progress",
            ));
        }
        if !session.scanning {
            return Ok(scan_ack(session));
        }
        let scanner_lease = session.scanner_lease.ok_or_else(|| {
            GateError::new(
                "scanner_lease_missing",
                "the native scanner ownership lease is unavailable",
            )
        })?;
        session.scan_transition = true;
        (
            session.client.clone(),
            scanner_lease,
            session.id.clone(),
            session.topology_generation,
            session.safety_generation,
        )
    };

    match client.stop_scanning().await {
        Ok(()) => {
            coordinator.release(scanner_lease);
            let mut inner = lock_inner(&state);
            let session = inner.session.as_mut().ok_or_else(not_initialized)?;
            validate_generation(session, &session_id, topology_generation, safety_generation)?;
            if session.scanner_lease == Some(scanner_lease) {
                session.scanner_lease = None;
            }
            session.scanning = false;
            session.scan_transition = false;
            Ok(scan_ack(session))
        }
        Err(error) => {
            log::error!("embedded Buttplug scan stop failed: {error}");
            clear_scan_transition(&state, &session_id, topology_generation, safety_generation);
            // Scanner ownership is retained because the native scanner state is unknown.
            Err(GateError::new(
                "scan_stop_failed",
                "the native scanner did not confirm stop",
            ))
        }
    }
}

#[tauri::command]
async fn experimental_buttplug_list_devices(
    state: State<'_, GateState>,
    request: FenceRequest,
) -> Result<NativeEvent, GateError> {
    validate_schema(request.schema_version)?;
    let session_id = {
        let inner = lock_inner(&state);
        let session = checked_fence(&inner, &request)?;
        session.id.clone()
    };
    synchronize_topology(&state, &session_id).await?;
    current_topology_event(&state, &session_id)
}

#[tauri::command]
async fn experimental_buttplug_vibrate(
    state: State<'_, GateState>,
    request: VibrateRequest,
) -> Result<OperationAck, GateError> {
    validate_schema(request.schema_version)?;
    validate_intensity(request.intensity)?;
    let (client, target) = {
        let inner = lock_inner(&state);
        let session = checked_vibrate_fence(&inner, &request)?;
        ensure_output_allowed(session)?;
        let target = session
            .registry
            .resolve_vibrate(&request.device_id, &request.feature_id)
            .ok_or_else(unknown_feature)?;
        (session.client.clone(), target)
    };

    let _output = state.shared.output.lock().await;
    {
        let inner = lock_inner(&state);
        let session = checked_vibrate_fence(&inner, &request)?;
        ensure_output_allowed(session)?;
        if session
            .registry
            .resolve_vibrate(&request.device_id, &request.feature_id)
            != Some(target.clone())
        {
            return Err(unknown_feature());
        }
    }

    let feature = current_vibrate_feature(&client, &target)?;
    let step = quantize_down(request.intensity, target.step_count);
    let command = ClientDeviceOutputCommand::Vibrate(ClientDeviceCommandValue::Steps(step as i32));
    if let Err(error) = feature.run_output(&command).await {
        log::error!("embedded Buttplug vibrate write failed: {error}");
        return Err(GateError::new(
            "vibrate_write_failed",
            "the native vibration write failed",
        ));
    }

    let still_current = {
        let inner = lock_inner(&state);
        inner.session.as_ref().is_some_and(|session| {
            fence_matches_vibrate(session, &request)
                && !session.output_blocked
                && !session.output_faulted
                && !session.terminal
        })
    };
    if !still_current {
        if let Err(error) = stop_exact_feature(&feature).await {
            log::error!("stale native vibration write could not be stopped: {error}");
            mark_stop_failure(&state, &request.session_id, "stop-failed");
            return Err(stop_failed());
        }
        return Err(GateError::new(
            "stale_after_write_stopped",
            "the native fence changed while writing; the feature was stopped",
        ));
    }

    operation_ack(
        &state,
        &request.session_id,
        Some(f64::from(step) / f64::from(target.step_count)),
    )
}

#[tauri::command]
async fn experimental_buttplug_stop_feature(
    state: State<'_, GateState>,
    request: StopFeatureRequest,
) -> Result<OperationAck, GateError> {
    validate_schema(request.schema_version)?;
    let (client, session_id, target) = {
        let mut inner = lock_inner(&state);
        let session = inner.session.as_mut().ok_or_else(not_initialized)?;
        advance_safety(session)?;
        session.output_blocked = true;
        (
            session.client.clone(),
            session.id.clone(),
            session
                .registry
                .resolve_vibrate(&request.device_id, &request.feature_id),
        )
    };

    let _output = state.shared.output.lock().await;
    let exact_result = match target {
        Some(target) => match current_vibrate_feature(&client, &target) {
            Ok(feature) => stop_exact_feature(&feature).await,
            Err(_) => client.stop_all_devices().await,
        },
        // Unknown/stale stop targets fall back to the global stop path.
        None => client.stop_all_devices().await,
    };

    if let Err(error) = exact_result {
        log::error!("embedded Buttplug feature stop failed, trying global stop: {error}");
        if let Err(global_error) = client.stop_all_devices().await {
            log::error!("embedded Buttplug global stop fallback failed: {global_error}");
            mark_stop_failure(&state, &session_id, "stop-failed");
            return Err(stop_failed());
        }
    }
    clear_output_transition(&state, &session_id);
    operation_ack(&state, &session_id, None)
}

#[tauri::command]
async fn experimental_buttplug_stop_all(
    state: State<'_, GateState>,
    request: GlobalRequest,
) -> Result<GlobalAck, GateError> {
    validate_schema(request.schema_version)?;
    run_global_stop(&state).await?;
    Ok(global_ack(&state))
}

#[tauri::command]
async fn experimental_buttplug_disconnect(
    state: State<'_, GateState>,
    coordinator: State<'_, ScanCoordinator>,
    request: DeviceRequest,
) -> Result<OperationAck, GateError> {
    validate_schema(request.schema_version)?;
    let session_id = {
        let inner = lock_inner(&state);
        let session = checked_device_fence(&inner, &request)?;
        if !session.registry.contains_device_id(&request.device_id) {
            return Err(GateError::new("unknown_device", "deviceId is unknown"));
        }
        session.id.clone()
    };

    // Buttplug 10 does not expose a safe per-device disconnect command. End the
    // entire embedded session after a global stop instead of pretending one BLE
    // link was released or reaching through to arbitrary transport internals.
    run_global_stop(&state).await?;
    let ack = operation_ack(&state, &session_id, None)?;
    close_transport(&state, &coordinator, &session_id, "device-disconnect").await?;
    Ok(ack)
}

#[tauri::command]
async fn experimental_buttplug_close(
    state: State<'_, GateState>,
    coordinator: State<'_, ScanCoordinator>,
    request: GlobalRequest,
) -> Result<GlobalAck, GateError> {
    validate_schema(request.schema_version)?;
    let session_id = lock_inner(&state)
        .session
        .as_ref()
        .map(|session| session.id.clone());
    let Some(session_id) = session_id else {
        return Ok(global_ack(&state));
    };

    let stop_result = run_global_stop(&state).await;
    let close_result = close_transport(&state, &coordinator, &session_id, "closed").await;
    stop_result?;
    close_result?;
    Ok(global_ack(&state))
}

fn release_session_scanner_lease(
    state: &GateState,
    coordinator: &ScanCoordinator,
    session_id: &str,
) {
    let lease = {
        let mut inner = lock_inner(state);
        matching_session_mut(&mut inner, session_id)
            .and_then(|session| session.scanner_lease.take())
    };
    if let Some(lease) = lease {
        coordinator.release(lease);
    }
}

async fn handle_client_event(
    state: &GateState,
    coordinator: &ScanCoordinator,
    session_id: &str,
    event: ButtplugClientEvent,
) {
    match event {
        ButtplugClientEvent::DeviceAdded(device) => {
            if let Err(error) = replace_added_connection(state, session_id, &device).await {
                log::error!(
                    "embedded Buttplug rejected added topology: {}",
                    error.message
                );
                fail_session(state, session_id, "topology-unavailable").await;
            }
        }
        ButtplugClientEvent::DeviceRemoved(device) => {
            if let Err(error) = remove_connection(state, session_id, device.index()).await {
                log::error!(
                    "embedded Buttplug rejected removed topology: {}",
                    error.message
                );
                fail_session(state, session_id, "topology-unavailable").await;
            }
        }
        ButtplugClientEvent::DeviceListReceived => {
            if let Err(error) = synchronize_topology(state, session_id).await {
                log::error!("embedded Buttplug rejected device list: {}", error.message);
                fail_session(state, session_id, "topology-unavailable").await;
            }
        }
        ButtplugClientEvent::ScanningFinished => {
            release_session_scanner_lease(state, coordinator, session_id);
            let mut inner = lock_inner(state);
            if let Some(session) = matching_session_mut(&mut inner, session_id) {
                session.scanning = false;
                session.scan_transition = false;
            }
        }
        ButtplugClientEvent::ServerDisconnect | ButtplugClientEvent::PingTimeout => {
            release_session_scanner_lease(state, coordinator, session_id);
            mark_terminal(state, session_id, "native-session-ended", true);
        }
        ButtplugClientEvent::Error(error) => {
            log::error!("embedded Buttplug asynchronous error: {error}");
        }
        ButtplugClientEvent::ServerConnect => {}
    }
}

fn handle_event_stream_end(state: &GateState, coordinator: &ScanCoordinator, session_id: &str) {
    release_session_scanner_lease(state, coordinator, session_id);
    let should_mark = lock_inner(state)
        .session
        .as_ref()
        .is_some_and(|session| session.id == session_id && !session.closing);
    if should_mark {
        mark_terminal(state, session_id, "native-event-stream-ended", true);
    }
}

async fn synchronize_topology(state: &GateState, session_id: &str) -> Result<(), GateError> {
    let _topology = state.shared.topology.lock().await;
    let client = {
        let inner = lock_inner(state);
        let session = matching_session(&inner, session_id)?;
        if session.terminal || session.closing {
            return Err(GateError::new(
                "session_ended",
                "the native backend session has ended",
            ));
        }
        session.client.clone()
    };
    let descriptors = client
        .devices()
        .values()
        .map(device_descriptor)
        .filter(|descriptor| !descriptor.features.is_empty())
        .collect::<Vec<_>>();
    let changed = {
        let mut inner = lock_inner(state);
        let session = matching_session_mut(&mut inner, session_id).ok_or_else(not_initialized)?;
        let changed = session.registry.reconcile(descriptors)?;
        if changed {
            advance_topology_and_safety(session)?;
            session.output_blocked = true;
        }
        changed
    };
    finish_topology_update(state, session_id, changed).await
}

async fn replace_added_connection(
    state: &GateState,
    session_id: &str,
    device: &ButtplugClientDevice,
) -> Result<(), GateError> {
    let descriptor = device_descriptor(device);
    if descriptor.features.is_empty() {
        return synchronize_topology(state, session_id).await;
    }
    let _topology = state.shared.topology.lock().await;
    {
        let mut inner = lock_inner(state);
        let session = matching_session_mut(&mut inner, session_id).ok_or_else(not_initialized)?;
        session.registry.replace_connection(descriptor)?;
        advance_topology_and_safety(session)?;
        session.output_blocked = true;
    }
    finish_topology_update(state, session_id, true).await
}

async fn remove_connection(
    state: &GateState,
    session_id: &str,
    device_index: u32,
) -> Result<(), GateError> {
    let _topology = state.shared.topology.lock().await;
    let changed = {
        let mut inner = lock_inner(state);
        let session = matching_session_mut(&mut inner, session_id).ok_or_else(not_initialized)?;
        let changed = session.registry.remove_connection(device_index);
        if changed {
            advance_topology_and_safety(session)?;
            session.output_blocked = true;
        }
        changed
    };
    finish_topology_update(state, session_id, changed).await
}

async fn finish_topology_update(
    state: &GateState,
    session_id: &str,
    changed: bool,
) -> Result<(), GateError> {
    if changed {
        stop_for_topology_transition(state, session_id).await?;
    }
    refresh_telemetry(state, session_id).await;
    send_current_topology(state, session_id)
}

async fn stop_for_topology_transition(
    state: &GateState,
    session_id: &str,
) -> Result<(), GateError> {
    let client = {
        let inner = lock_inner(state);
        matching_session(&inner, session_id)?.client.clone()
    };
    let _output = state.shared.output.lock().await;
    if let Err(error) = client.stop_all_devices().await {
        log::error!("embedded Buttplug topology stop failed: {error}");
        mark_stop_failure(state, session_id, "stop-failed");
        return Err(stop_failed());
    }
    clear_output_transition(state, session_id);
    Ok(())
}

async fn refresh_telemetry(state: &GateState, session_id: &str) {
    let (client, targets) = {
        let inner = lock_inner(state);
        let Ok(session) = matching_session(&inner, session_id) else {
            return;
        };
        (session.client.clone(), session.registry.telemetry_targets())
    };
    let devices = client.devices();
    let reads = targets.into_iter().map(|target| {
        let feature = devices
            .get(&target.device_index)
            .and_then(|device| device.device_features().get(&target.feature_index))
            .cloned();
        async move {
            let value = match (target.kind, feature) {
                (TelemetryKind::Battery, Some(feature)) => {
                    match tokio::time::timeout(TELEMETRY_TIMEOUT, feature.battery()).await {
                        Ok(Ok(level)) if level <= 100 => {
                            Some(TelemetryValue::Battery(f64::from(level) / 100.0))
                        }
                        _ => None,
                    }
                }
                (TelemetryKind::Rssi, Some(feature)) => {
                    match tokio::time::timeout(TELEMETRY_TIMEOUT, feature.rssi()).await {
                        Ok(Ok(level)) if (-127..=20).contains(&level) => {
                            Some(TelemetryValue::Rssi(i16::from(level)))
                        }
                        _ => None,
                    }
                }
                (_, None) => None,
            };
            (target, value)
        }
    });
    let readings = futures::future::join_all(reads).await;
    let mut inner = lock_inner(state);
    if let Some(session) = matching_session_mut(&mut inner, session_id) {
        for (target, value) in readings {
            session.registry.update_telemetry(&target, value);
        }
    }
}

fn device_descriptor(device: &ButtplugClientDevice) -> DeviceDescriptor {
    let mut features = Vec::new();
    for (feature_index, feature) in device.device_features() {
        if let Some(output) = feature.feature().get_output_limits(OutputType::Vibrate) {
            let step_count = output.step_count();
            if (1..=MAX_STEP_COUNT).contains(&step_count) {
                features.push((*feature_index, FeatureDescriptor::Vibrate { step_count }));
            }
        }
        if supports_read_input(feature.feature(), InputType::Battery) {
            features.push((*feature_index, FeatureDescriptor::Battery));
        }
        if supports_read_input(feature.feature(), InputType::Rssi) {
            features.push((*feature_index, FeatureDescriptor::Rssi));
        }
    }
    DeviceDescriptor {
        index: device.index(),
        name: normalized_name(device),
        features,
    }
}

fn supports_read_input(
    feature: &buttplug_core::message::DeviceFeature,
    input_type: InputType,
) -> bool {
    feature
        .get_input(input_type)
        .is_some_and(|input| input.command().contains(InputCommandType::Read))
}

fn normalized_name(device: &ButtplugClientDevice) -> String {
    let candidate = device
        .display_name()
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| device.name());
    let truncated = candidate.chars().take(256).collect::<String>();
    if truncated.trim().is_empty() {
        "Connected device".to_owned()
    } else {
        truncated
    }
}

fn current_vibrate_feature(
    client: &ButtplugClient,
    target: &VibrateTarget,
) -> Result<buttplug_client::device::ClientDeviceFeature, GateError> {
    let devices = client.devices();
    let device = devices
        .get(&target.device_index)
        .filter(|device| device.connected())
        .ok_or_else(unknown_feature)?;
    let feature = device
        .device_features()
        .get(&target.feature_index)
        .filter(|feature| {
            feature
                .feature()
                .get_output_limits(OutputType::Vibrate)
                .is_some_and(|limits| limits.step_count() == target.step_count)
        })
        .cloned()
        .ok_or_else(unknown_feature)?;
    Ok(feature)
}

async fn stop_exact_feature(
    feature: &buttplug_client::device::ClientDeviceFeature,
) -> Result<(), buttplug_client::ButtplugClientError> {
    feature
        .run_output(&ClientDeviceOutputCommand::Vibrate(
            ClientDeviceCommandValue::Steps(0),
        ))
        .await
}

async fn run_global_stop(state: &GateState) -> Result<(), GateError> {
    let (client, session_id) = {
        let mut inner = lock_inner(state);
        let Some(session) = inner.session.as_mut() else {
            return Ok(());
        };
        advance_safety(session)?;
        session.output_blocked = true;
        (session.client.clone(), session.id.clone())
    };
    let _output = state.shared.output.lock().await;
    if let Err(error) = client.stop_all_devices().await {
        log::error!("embedded Buttplug global stop failed: {error}");
        mark_stop_failure(state, &session_id, "stop-failed");
        return Err(stop_failed());
    }
    clear_output_transition(state, &session_id);
    Ok(())
}

async fn close_transport(
    state: &GateState,
    coordinator: &ScanCoordinator,
    session_id: &str,
    reason: &str,
) -> Result<(), GateError> {
    let (client, scanning, event) = {
        let mut inner = lock_inner(state);
        let session = matching_session_mut(&mut inner, session_id).ok_or_else(not_initialized)?;
        session.closing = true;
        session.output_blocked = true;
        (
            session.client.clone(),
            session.scanner_lease.is_some(),
            NativeEvent::SessionEnded {
                schema_version: SCHEMA_VERSION,
                session_id: session.id.clone(),
                topology_generation: session.topology_generation,
                safety_generation: session.safety_generation,
                reason: reason.to_owned(),
            },
        )
    };

    if scanning {
        if let Err(error) = client.stop_scanning().await {
            log::error!("embedded Buttplug close could not stop scanning: {error}");
        }
    }
    let disconnect_result = if client.connected() {
        client.disconnect().await
    } else {
        Ok(())
    };
    if let Err(error) = disconnect_result {
        log::error!("embedded Buttplug client disconnect failed: {error}");
        mark_terminal(state, session_id, "disconnect-failed", false);
        return Err(GateError::new(
            "disconnect_failed",
            "the embedded device session did not disconnect",
        ));
    }

    release_session_scanner_lease(state, coordinator, session_id);
    let channel = {
        let mut inner = lock_inner(state);
        let Some(session) = inner.session.as_ref() else {
            return Ok(());
        };
        if session.id != session_id {
            return Err(stale_session());
        }
        let channel = session.events.clone();
        inner.session = None;
        channel
    };
    if let Err(error) = channel.send(event) {
        log::error!("embedded Buttplug close event delivery failed: {error}");
    }
    Ok(())
}

async fn fail_session(state: &GateState, session_id: &str, reason: &str) {
    if let Err(error) = run_global_stop(state).await {
        log::error!(
            "embedded Buttplug failure stop was not acknowledged: {}",
            error.message
        );
    }
    mark_terminal(state, session_id, reason, true);
}

#[cfg(target_os = "android")]
fn request_lifecycle_stop(state: GateState, coordinator: ScanCoordinator) {
    tauri::async_runtime::spawn(async move {
        if coordinator
            .lease()
            .is_some_and(|lease| lease.owner() == ScannerOwner::DgPluginBlec)
        {
            // Scanner cleanup and output stop are independent. A DG scan may
            // coexist with an already-connected embedded output device.
            crate::scan_coordinator::request_dg_lifecycle_cleanup(coordinator.clone());
        }

        if let Err(error) = run_global_stop(&state).await {
            log::error!("embedded Buttplug lifecycle stop failed: {}", error.message);
        }
        let session_id = lock_inner(&state)
            .session
            .as_ref()
            .map(|session| session.id.clone());
        if let Some(session_id) = session_id {
            if let Err(error) =
                close_transport(&state, &coordinator, &session_id, "android-lifecycle").await
            {
                log::error!(
                    "embedded Buttplug lifecycle teardown failed: {}",
                    error.message
                );
            }
        }
    });
}

fn send_current_topology(state: &GateState, session_id: &str) -> Result<(), GateError> {
    let (channel, event) = {
        let inner = lock_inner(state);
        let session = matching_session(&inner, session_id)?;
        if session.terminal || session.closing {
            return Err(GateError::new(
                "session_ended",
                "the native backend session has ended",
            ));
        }
        (session.events.clone(), topology_event(session))
    };
    channel.send(event).map_err(|error| {
        log::error!("embedded Buttplug topology delivery failed: {error}");
        GateError::new(
            "event_delivery_failed",
            "the native topology channel is unavailable",
        )
    })
}

fn mark_stop_failure(state: &GateState, session_id: &str, reason: &str) {
    mark_terminal(state, session_id, reason, false);
}

fn mark_terminal(state: &GateState, session_id: &str, reason: &str, structural: bool) {
    let event = {
        let mut inner = lock_inner(state);
        let Some(session) = matching_session_mut(&mut inner, session_id) else {
            return;
        };
        if session.closing {
            return;
        }
        if structural {
            session.registry = ConnectionRegistry::default();
            if advance_topology_and_safety(session).is_err() {
                session.topology_generation = u64::MAX;
                session.safety_generation = u64::MAX;
            }
        } else if advance_safety(session).is_err() {
            session.safety_generation = u64::MAX;
        }
        session.output_blocked = true;
        session.output_faulted = true;
        session.terminal = true;
        session.scanning = false;
        session.scan_transition = false;
        if session.terminal_event_sent {
            return;
        }
        session.terminal_event_sent = true;
        (
            session.events.clone(),
            NativeEvent::SessionEnded {
                schema_version: SCHEMA_VERSION,
                session_id: session.id.clone(),
                topology_generation: session.topology_generation,
                safety_generation: session.safety_generation,
                reason: reason.to_owned(),
            },
        )
    };
    if let Err(error) = event.0.send(event.1) {
        log::error!("embedded Buttplug terminal event delivery failed: {error}");
    }
}

fn session_response(state: &GateState, session_id: &str) -> Result<InitializeResponse, GateError> {
    let inner = lock_inner(state);
    let session = matching_session(&inner, session_id)?;
    Ok(InitializeResponse {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        topology_generation: session.topology_generation,
        safety_generation: session.safety_generation,
        scanning: session.scanning,
    })
}

fn current_topology_event(state: &GateState, session_id: &str) -> Result<NativeEvent, GateError> {
    let inner = lock_inner(state);
    Ok(topology_event(matching_session(&inner, session_id)?))
}

fn topology_event(session: &GateSession) -> NativeEvent {
    NativeEvent::Topology {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        topology_generation: session.topology_generation,
        safety_generation: session.safety_generation,
        devices: session.registry.topology(),
    }
}

fn operation_ack(
    state: &GateState,
    session_id: &str,
    applied_intensity: Option<f64>,
) -> Result<OperationAck, GateError> {
    let inner = lock_inner(state);
    let session = matching_session(&inner, session_id)?;
    Ok(OperationAck {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        topology_generation: session.topology_generation,
        safety_generation: session.safety_generation,
        acknowledged: true,
        hardware_state: HardwareState::Unknown,
        applied_intensity,
    })
}

fn global_ack(state: &GateState) -> GlobalAck {
    let inner = lock_inner(state);
    let current = inner.session.as_ref();
    GlobalAck {
        schema_version: SCHEMA_VERSION,
        acknowledged: true,
        hardware_state: HardwareState::Unknown,
        session_id: current.map(|session| session.id.clone()),
        topology_generation: current.map(|session| session.topology_generation),
        safety_generation: current.map(|session| session.safety_generation),
    }
}

fn scan_ack(session: &GateSession) -> ScanAck {
    ScanAck {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        topology_generation: session.topology_generation,
        safety_generation: session.safety_generation,
        scanning: session.scanning,
    }
}

fn checked_fence<'a>(
    inner: &'a GateInner,
    request: &FenceRequest,
) -> Result<&'a GateSession, GateError> {
    let session = inner.session.as_ref().ok_or_else(not_initialized)?;
    validate_generation(
        session,
        &request.session_id,
        request.topology_generation,
        request.safety_generation,
    )?;
    Ok(session)
}

fn checked_fence_mut<'a>(
    inner: &'a mut GateInner,
    request: &FenceRequest,
) -> Result<&'a mut GateSession, GateError> {
    let session = inner.session.as_mut().ok_or_else(not_initialized)?;
    validate_generation(
        session,
        &request.session_id,
        request.topology_generation,
        request.safety_generation,
    )?;
    Ok(session)
}

fn checked_device_fence<'a>(
    inner: &'a GateInner,
    request: &DeviceRequest,
) -> Result<&'a GateSession, GateError> {
    let session = inner.session.as_ref().ok_or_else(not_initialized)?;
    validate_generation(
        session,
        &request.session_id,
        request.topology_generation,
        request.safety_generation,
    )?;
    Ok(session)
}

fn checked_vibrate_fence<'a>(
    inner: &'a GateInner,
    request: &VibrateRequest,
) -> Result<&'a GateSession, GateError> {
    let session = inner.session.as_ref().ok_or_else(not_initialized)?;
    validate_generation(
        session,
        &request.session_id,
        request.topology_generation,
        request.safety_generation,
    )?;
    Ok(session)
}

fn fence_matches_vibrate(session: &GateSession, request: &VibrateRequest) -> bool {
    session.id == request.session_id
        && session.topology_generation == request.topology_generation
        && session.safety_generation == request.safety_generation
}

fn validate_generation(
    session: &GateSession,
    session_id: &str,
    topology_generation: u64,
    safety_generation: u64,
) -> Result<(), GateError> {
    if session.id != session_id {
        return Err(stale_session());
    }
    if session.topology_generation != topology_generation {
        return Err(GateError::new(
            "stale_topology",
            "topologyGeneration is stale",
        ));
    }
    if session.safety_generation != safety_generation {
        return Err(GateError::new("stale_safety", "safetyGeneration is stale"));
    }
    Ok(())
}

fn ensure_operational(session: &GateSession) -> Result<(), GateError> {
    if session.terminal || session.closing || session.output_faulted {
        Err(GateError::new(
            "session_ended",
            "the native backend session is not operational",
        ))
    } else {
        Ok(())
    }
}

fn ensure_output_allowed(session: &GateSession) -> Result<(), GateError> {
    ensure_operational(session)?;
    if session.output_blocked {
        Err(GateError::new(
            "stop_barrier_active",
            "a native stop transition is active",
        ))
    } else {
        Ok(())
    }
}

fn advance_topology_and_safety(session: &mut GateSession) -> Result<(), GateError> {
    session.topology_generation = session
        .topology_generation
        .checked_add(1)
        .ok_or_else(generation_exhausted)?;
    advance_safety(session)
}

fn advance_safety(session: &mut GateSession) -> Result<(), GateError> {
    session.safety_generation = session
        .safety_generation
        .checked_add(1)
        .ok_or_else(generation_exhausted)?;
    Ok(())
}

fn clear_output_transition(state: &GateState, session_id: &str) {
    let mut inner = lock_inner(state);
    if let Some(session) = matching_session_mut(&mut inner, session_id) {
        session.output_blocked = false;
    }
}

fn clear_scan_transition(
    state: &GateState,
    session_id: &str,
    topology_generation: u64,
    safety_generation: u64,
) {
    let mut inner = lock_inner(state);
    if let Some(session) = matching_session_mut(&mut inner, session_id) {
        if session.topology_generation == topology_generation
            && session.safety_generation == safety_generation
        {
            session.scan_transition = false;
        }
    }
}

fn matching_session<'a>(
    inner: &'a GateInner,
    session_id: &str,
) -> Result<&'a GateSession, GateError> {
    inner
        .session
        .as_ref()
        .filter(|session| session.id == session_id)
        .ok_or_else(stale_session)
}

fn matching_session_mut<'a>(
    inner: &'a mut GateInner,
    session_id: &str,
) -> Option<&'a mut GateSession> {
    inner
        .session
        .as_mut()
        .filter(|session| session.id == session_id)
}

fn lock_inner(state: &GateState) -> std::sync::MutexGuard<'_, GateInner> {
    state
        .shared
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn quantize_down(intensity: f64, step_count: u32) -> u32 {
    (intensity * f64::from(step_count)).floor() as u32
}

fn unknown_feature() -> GateError {
    GateError::new(
        "unknown_feature",
        "the exact deviceId and featureId pair is unavailable",
    )
}

fn not_initialized() -> GateError {
    GateError::new(
        "not_initialized",
        "the embedded device backend is not initialized",
    )
}

fn stale_session() -> GateError {
    GateError::new("stale_session", "sessionId is stale")
}

fn stop_failed() -> GateError {
    GateError::new(
        "stop_failed",
        "native stop was not acknowledged; hardware state is unknown",
    )
}

fn generation_exhausted() -> GateError {
    GateError::new(
        "generation_exhausted",
        "the native generation counter is exhausted",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_quantization_always_rounds_down() {
        assert_eq!(quantize_down(0.0, 20), 0);
        assert_eq!(quantize_down(0.249, 20), 4);
        assert_eq!(quantize_down(0.25, 20), 5);
        assert_eq!(quantize_down(1.0, 20), 20);
    }

    #[test]
    fn fence_requires_session_topology_and_safety_generations() {
        let channel = Channel::new(|_| Ok(()));
        let client = Arc::new(ButtplugClient::new("test"));
        let mut session = GateSession {
            id: "session".to_owned(),
            topology_generation: 2,
            safety_generation: 3,
            client,
            scanning: false,
            scan_transition: false,
            scanner_lease: None,
            output_blocked: false,
            output_faulted: false,
            terminal: false,
            closing: false,
            terminal_event_sent: false,
            registry: ConnectionRegistry::default(),
            events: channel,
        };
        assert!(validate_generation(&session, "session", 2, 3).is_ok());
        assert_eq!(
            validate_generation(&session, "session", 1, 3)
                .unwrap_err()
                .code,
            "stale_topology"
        );
        advance_safety(&mut session).unwrap();
        assert_eq!(
            validate_generation(&session, "session", 2, 3)
                .unwrap_err()
                .code,
            "stale_safety"
        );
    }
}

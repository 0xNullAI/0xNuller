pub(crate) mod scan_coordinator;
mod schema;

use self::{
    scan_coordinator::{ScanCoordinator, ScannerOwner},
    schema::{
        validate_schema, DeviceCapabilities, DeviceList, DeviceMetadata, EmergencyStopAck,
        GateError, HardwareState, InitializeRequest, InitializeResponse, ScanAck, SessionRequest,
        StopAllRequest, SCHEMA_VERSION,
    },
};
use buttplug_client::ButtplugClient;
use buttplug_client_in_process::in_process_client;
use buttplug_core::message::{InputType, OutputType};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};
use tauri::State;
use uuid::Uuid;

#[derive(Default)]
struct GateState {
    initialization: tokio::sync::Mutex<()>,
    inner: Mutex<GateInner>,
}

#[derive(Default)]
struct GateInner {
    session: Option<GateSession>,
}

struct GateSession {
    id: String,
    generation: u64,
    client: Arc<ButtplugClient>,
    scanning: bool,
    scan_transition: bool,
    device_ids: BTreeMap<u32, String>,
}

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(GateState::default())
        .manage(ScanCoordinator::default())
        .invoke_handler(tauri::generate_handler![
            experimental_buttplug_initialize,
            experimental_buttplug_start_scan,
            experimental_buttplug_stop_scan,
            experimental_buttplug_list_devices,
            experimental_buttplug_stop_all,
        ])
}

#[tauri::command]
async fn experimental_buttplug_initialize(
    state: State<'_, GateState>,
    request: InitializeRequest,
) -> Result<InitializeResponse, GateError> {
    validate_schema(request.schema_version)?;
    let _initialization = state.initialization.lock().await;

    if let Some(response) = initialized_response(&state) {
        return Ok(response);
    }

    #[cfg(target_os = "android")]
    if !crate::buttplug_android::ready() {
        return Err(GateError::new(
            "native_not_ready",
            "btleplug Android JNI initialization is unavailable",
        ));
    }

    // This initializes only the in-process server and BLE manager. Scanning is
    // always an explicit, separately coordinated command.
    let client = Arc::new(in_process_client("0xNuller Buttplug Gate 0").await);
    let session = GateSession {
        id: Uuid::new_v4().to_string(),
        generation: 0,
        client,
        scanning: false,
        scan_transition: false,
        device_ids: BTreeMap::new(),
    };
    let response = InitializeResponse {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        generation: session.generation,
        scanning: false,
    };
    state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .session = Some(session);
    Ok(response)
}

#[tauri::command]
async fn experimental_buttplug_start_scan(
    state: State<'_, GateState>,
    coordinator: State<'_, ScanCoordinator>,
    request: SessionRequest,
) -> Result<ScanAck, GateError> {
    validate_schema(request.schema_version)?;
    let (client, session_id, generation, next_generation) = {
        let mut inner = state
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let session = checked_session_mut(&mut inner, &request)?;
        if session.scan_transition {
            return Err(GateError::new(
                "scan_transition",
                "a scan transition is already in progress",
            ));
        }
        if session.scanning {
            return Ok(scan_ack(session));
        }
        let next_generation = session
            .generation
            .checked_add(1)
            .ok_or_else(|| GateError::new("generation_exhausted", "scan generation exhausted"))?;
        coordinator.try_claim(ScannerOwner::Buttplug).map_err(|_| {
            GateError::new(
                "scanner_in_use",
                "the BLE scanner is owned by another backend",
            )
        })?;
        session.scan_transition = true;
        (
            session.client.clone(),
            session.id.clone(),
            session.generation,
            next_generation,
        )
    };

    match client.start_scanning().await {
        Ok(()) => {
            let mut inner = state
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let session = inner.session.as_mut().ok_or_else(not_initialized)?;
            if session.id != session_id || session.generation != generation {
                // Retain ownership: start succeeded, so releasing here could permit
                // another backend to scan while the underlying state is uncertain.
                return Err(GateError::new(
                    "stale_session",
                    "the scan completed for a stale session",
                ));
            }
            session.generation = next_generation;
            session.device_ids.clear();
            session.scanning = true;
            session.scan_transition = false;
            Ok(scan_ack(session))
        }
        Err(error) => {
            coordinator.release(ScannerOwner::Buttplug);
            let mut inner = state
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(session) = inner.session.as_mut() {
                if session.id == session_id && session.generation == generation {
                    session.scan_transition = false;
                }
            }
            Err(operation_error("scan_start_failed", error))
        }
    }
}

#[tauri::command]
async fn experimental_buttplug_stop_scan(
    state: State<'_, GateState>,
    coordinator: State<'_, ScanCoordinator>,
    request: SessionRequest,
) -> Result<ScanAck, GateError> {
    validate_schema(request.schema_version)?;
    let (client, session_id, generation) = {
        let mut inner = state
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let session = checked_session_mut(&mut inner, &request)?;
        if session.scan_transition {
            return Err(GateError::new(
                "scan_transition",
                "a scan transition is already in progress",
            ));
        }
        if !session.scanning {
            return Ok(scan_ack(session));
        }
        session.scan_transition = true;
        (
            session.client.clone(),
            session.id.clone(),
            session.generation,
        )
    };

    match client.stop_scanning().await {
        Ok(()) => {
            coordinator.release(ScannerOwner::Buttplug);
            let mut inner = state
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let session = inner.session.as_mut().ok_or_else(not_initialized)?;
            if session.id != session_id || session.generation != generation {
                return Err(GateError::new(
                    "stale_session",
                    "the scan stopped for a stale session",
                ));
            }
            session.scanning = false;
            session.scan_transition = false;
            Ok(scan_ack(session))
        }
        Err(error) => {
            let mut inner = state
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(session) = inner.session.as_mut() {
                if session.id == session_id && session.generation == generation {
                    session.scan_transition = false;
                }
            }
            // Keep ownership on failure because the underlying scanner state is unknown.
            Err(operation_error("scan_stop_failed", error))
        }
    }
}

#[tauri::command]
async fn experimental_buttplug_list_devices(
    state: State<'_, GateState>,
    request: SessionRequest,
) -> Result<DeviceList, GateError> {
    validate_schema(request.schema_version)?;
    let client = {
        let inner = state
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let session = checked_session(&inner, &request)?;
        if session.scan_transition {
            return Err(GateError::new(
                "scan_transition",
                "device metadata is unavailable during a scan transition",
            ));
        }
        session.client.clone()
    };
    let buttplug_devices = client.devices();
    let current_indices: BTreeSet<u32> = buttplug_devices.keys().copied().collect();

    let mut inner = state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let session = checked_session_mut(&mut inner, &request)?;
    session
        .device_ids
        .retain(|device_index, _| current_indices.contains(device_index));

    let mut devices = buttplug_devices
        .into_iter()
        .map(|(device_index, device)| {
            let device_id = session
                .device_ids
                .entry(device_index)
                .or_insert_with(|| Uuid::new_v4().to_string())
                .clone();
            DeviceMetadata {
                device_id,
                name: device.name().clone(),
                display_name: device.display_name().clone(),
                connected: device.connected(),
                capabilities: DeviceCapabilities {
                    vibrate: device.output_available(OutputType::Vibrate),
                    battery: device.input_available(InputType::Battery),
                    rssi: device.input_available(InputType::Rssi),
                },
            }
        })
        .collect::<Vec<_>>();
    devices.sort_by(|left, right| left.device_id.cmp(&right.device_id));

    Ok(DeviceList {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        generation: session.generation,
        devices,
    })
}

#[tauri::command]
async fn experimental_buttplug_stop_all(
    state: State<'_, GateState>,
    request: StopAllRequest,
) -> Result<EmergencyStopAck, GateError> {
    validate_schema(request.schema_version)?;
    // Deliberately does not require a session token or scanner ownership. A stale
    // caller must still be able to reach the emergency stop path.
    let client = {
        let inner = state
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner
            .session
            .as_ref()
            .map(|session| session.client.clone())
            .ok_or_else(not_initialized)?
    };
    client
        .stop_all_devices()
        .await
        .map_err(|error| operation_error("stop_all_failed", error))?;

    let inner = state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let session = inner.session.as_ref().ok_or_else(not_initialized)?;
    Ok(EmergencyStopAck {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        generation: session.generation,
        acknowledged: true,
        // Buttplug acknowledges command handling, not physical actuator state.
        hardware_state: HardwareState::Unknown,
    })
}

fn initialized_response(state: &GateState) -> Option<InitializeResponse> {
    let inner = state
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    inner.session.as_ref().map(|session| InitializeResponse {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        generation: session.generation,
        scanning: session.scanning,
    })
}

fn checked_session<'a>(
    inner: &'a GateInner,
    request: &SessionRequest,
) -> Result<&'a GateSession, GateError> {
    let session = inner.session.as_ref().ok_or_else(not_initialized)?;
    validate_session(session, request)?;
    Ok(session)
}

fn checked_session_mut<'a>(
    inner: &'a mut GateInner,
    request: &SessionRequest,
) -> Result<&'a mut GateSession, GateError> {
    let session = inner.session.as_mut().ok_or_else(not_initialized)?;
    validate_session(session, request)?;
    Ok(session)
}

fn validate_session(session: &GateSession, request: &SessionRequest) -> Result<(), GateError> {
    if session.id != request.session_id || session.generation != request.generation {
        Err(GateError::new(
            "stale_session",
            "sessionId or generation is stale",
        ))
    } else {
        Ok(())
    }
}

fn scan_ack(session: &GateSession) -> ScanAck {
    ScanAck {
        schema_version: SCHEMA_VERSION,
        session_id: session.id.clone(),
        generation: session.generation,
        scanning: session.scanning,
    }
}

fn not_initialized() -> GateError {
    GateError::new("not_initialized", "Buttplug Gate 0 is not initialized")
}

fn operation_error(code: &'static str, error: impl std::fmt::Display) -> GateError {
    GateError::new(code, error.to_string())
}

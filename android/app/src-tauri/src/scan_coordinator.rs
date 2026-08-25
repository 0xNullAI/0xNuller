use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
#[cfg(not(feature = "experimental-buttplug-gate0"))]
use tauri::State;

/// BLE scanner ownership shared by the experimental backend and plugin-blec.
///
/// Claims are exclusive even for the same backend. A monotonically increasing
/// lease prevents delayed cleanup from releasing a newer scan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScannerOwner {
    #[cfg(any(feature = "experimental-buttplug-gate0", test))]
    Buttplug,
    DgPluginBlec,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ScannerLease {
    owner: ScannerOwner,
    id: u64,
}

impl ScannerLease {
    fn dg_plugin_blec(id: u64) -> Self {
        Self {
            owner: ScannerOwner::DgPluginBlec,
            id,
        }
    }

    fn id(self) -> u64 {
        self.id
    }

    #[cfg(feature = "experimental-buttplug-gate0")]
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn owner(self) -> ScannerOwner {
        self.owner
    }
}

#[derive(Debug, Default)]
struct CoordinatorState {
    lease: Option<ScannerLease>,
    next_id: u64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ScanCoordinator {
    state: Arc<Mutex<CoordinatorState>>,
}

impl ScanCoordinator {
    pub(crate) fn try_claim(&self, owner: ScannerOwner) -> Result<ScannerLease, ScannerOwner> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(current) = state.lease {
            return Err(current.owner);
        }
        state.next_id = state
            .next_id
            .checked_add(1)
            .expect("BLE scanner lease counter exhausted");
        let lease = ScannerLease {
            owner,
            id: state.next_id,
        };
        state.lease = Some(lease);
        Ok(lease)
    }

    /// Releases only the exact claim. Delayed cleanup for an older scan is a no-op.
    pub(crate) fn release(&self, lease: ScannerLease) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.lease == Some(lease) {
            state.lease = None;
            true
        } else {
            false
        }
    }

    pub(crate) fn lease(&self) -> Option<ScannerLease> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .lease
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DgScannerClaim {
    lease_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DgScannerReleaseRequest {
    lease_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScannerCoordinationError {
    code: &'static str,
    message: &'static str,
}

impl ScannerCoordinationError {
    fn scanner_in_use() -> Self {
        Self {
            code: "scanner_in_use",
            message: "the BLE scanner is owned by another scan",
        }
    }

    fn invalid_lease() -> Self {
        Self {
            code: "invalid_scanner_lease",
            message: "the BLE scanner lease is invalid or stale",
        }
    }
}

pub(crate) fn claim_dg_plugin_blec_scanner(
    coordinator: &ScanCoordinator,
) -> Result<DgScannerClaim, ScannerCoordinationError> {
    let lease = coordinator
        .try_claim(ScannerOwner::DgPluginBlec)
        .map_err(|_| ScannerCoordinationError::scanner_in_use())?;
    Ok(DgScannerClaim {
        lease_id: lease.id().to_string(),
    })
}

pub(crate) fn release_dg_plugin_blec_scanner(
    coordinator: &ScanCoordinator,
    request: DgScannerReleaseRequest,
) -> Result<(), ScannerCoordinationError> {
    let lease_id = request
        .lease_id
        .parse::<u64>()
        .map_err(|_| ScannerCoordinationError::invalid_lease())?;
    let lease = ScannerLease::dg_plugin_blec(lease_id);
    match coordinator.lease() {
        None => Ok(()), // Native lifecycle cleanup may already have released it.
        Some(current) if current == lease => {
            coordinator.release(lease);
            Ok(())
        }
        Some(_) => Err(ScannerCoordinationError::invalid_lease()),
    }
}

#[cfg(not(feature = "experimental-buttplug-gate0"))]
#[tauri::command]
fn dg_blec_claim_scanner(
    coordinator: State<'_, ScanCoordinator>,
) -> Result<DgScannerClaim, ScannerCoordinationError> {
    claim_dg_plugin_blec_scanner(&coordinator)
}

#[cfg(not(feature = "experimental-buttplug-gate0"))]
#[tauri::command]
fn dg_blec_release_scanner(
    coordinator: State<'_, ScanCoordinator>,
    request: DgScannerReleaseRequest,
) -> Result<(), ScannerCoordinationError> {
    release_dg_plugin_blec_scanner(&coordinator, request)
}

#[cfg(not(feature = "experimental-buttplug-gate0"))]
pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let coordinator = ScanCoordinator::default();

    #[cfg(target_os = "android")]
    crate::buttplug_android::install_lifecycle_stop_handler({
        let coordinator = coordinator.clone();
        move || request_dg_lifecycle_cleanup(coordinator.clone())
    });

    builder
        .manage(coordinator)
        .invoke_handler(tauri::generate_handler![
            dg_blec_claim_scanner,
            dg_blec_release_scanner,
        ])
}

/// Stops plugin-blec before releasing its scanner claim when Android tears
/// down or suspends the WebView. Failure retains the lease and therefore
/// keeps the experimental scanner fail-closed.
#[cfg(target_os = "android")]
pub(crate) fn request_dg_lifecycle_cleanup(coordinator: ScanCoordinator) {
    tauri::async_runtime::spawn(async move {
        let Some(lease) = coordinator.lease() else {
            return;
        };
        if lease.owner != ScannerOwner::DgPluginBlec {
            return;
        }
        let handler = match tauri_plugin_blec::get_handler() {
            Ok(handler) => handler,
            Err(error) => {
                log::error!("plugin-blec lifecycle scanner cleanup unavailable: {error}");
                return;
            }
        };
        if let Err(error) = handler.stop_scan().await {
            log::error!("plugin-blec lifecycle scanner cleanup failed: {error}");
            return;
        }
        coordinator.release(lease);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_buttplug_while_dg_owns_scanner_and_vice_versa() {
        let coordinator = ScanCoordinator::default();
        let dg = coordinator.try_claim(ScannerOwner::DgPluginBlec).unwrap();
        assert_eq!(
            coordinator.try_claim(ScannerOwner::Buttplug),
            Err(ScannerOwner::DgPluginBlec),
        );
        assert!(coordinator.release(dg));

        let buttplug = coordinator.try_claim(ScannerOwner::Buttplug).unwrap();
        assert_eq!(
            coordinator.try_claim(ScannerOwner::DgPluginBlec),
            Err(ScannerOwner::Buttplug),
        );
        assert!(coordinator.release(buttplug));
    }

    #[test]
    fn refuses_parallel_claims_from_the_same_backend() {
        let coordinator = ScanCoordinator::default();
        coordinator.try_claim(ScannerOwner::DgPluginBlec).unwrap();
        assert_eq!(
            coordinator.try_claim(ScannerOwner::DgPluginBlec),
            Err(ScannerOwner::DgPluginBlec),
        );
    }

    #[test]
    fn stale_cleanup_cannot_release_a_newer_scan() {
        let coordinator = ScanCoordinator::default();
        let first = coordinator.try_claim(ScannerOwner::DgPluginBlec).unwrap();
        assert!(coordinator.release(first));
        let second = coordinator.try_claim(ScannerOwner::DgPluginBlec).unwrap();

        assert!(!coordinator.release(first));
        assert_eq!(coordinator.lease(), Some(second));
        assert!(coordinator.release(second));
        assert_eq!(coordinator.lease(), None);
    }
}

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::State;

/// Exclusive plugin-blec scanner ownership.
///
/// Android has a single scanner callback per app, so parallel DG scans are
/// refused instead of silently replacing each other. A monotonically
/// increasing lease prevents delayed cleanup from releasing a newer scan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ScannerLease {
    id: u64,
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
    pub(crate) fn try_claim(&self) -> Option<ScannerLease> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.lease.is_some() {
            return None;
        }
        state.next_id = state
            .next_id
            .checked_add(1)
            .expect("BLE scanner lease counter exhausted");
        let lease = ScannerLease { id: state.next_id };
        state.lease = Some(lease);
        Some(lease)
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
        .try_claim()
        .ok_or_else(ScannerCoordinationError::scanner_in_use)?;
    Ok(DgScannerClaim {
        lease_id: lease.id.to_string(),
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
    let lease = ScannerLease { id: lease_id };
    match coordinator.lease() {
        None => Ok(()), // Native lifecycle cleanup may already have released it.
        Some(current) if current == lease => {
            coordinator.release(lease);
            Ok(())
        }
        Some(_) => Err(ScannerCoordinationError::invalid_lease()),
    }
}

#[tauri::command]
pub(crate) fn dg_blec_claim_scanner(
    coordinator: State<'_, ScanCoordinator>,
) -> Result<DgScannerClaim, ScannerCoordinationError> {
    claim_dg_plugin_blec_scanner(&coordinator)
}

#[tauri::command]
pub(crate) fn dg_blec_release_scanner(
    coordinator: State<'_, ScanCoordinator>,
    request: DgScannerReleaseRequest,
) -> Result<(), ScannerCoordinationError> {
    release_dg_plugin_blec_scanner(&coordinator, request)
}

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let coordinator = ScanCoordinator::default();

    #[cfg(target_os = "android")]
    crate::android_lifecycle::install_lifecycle_stop_handler({
        let coordinator = coordinator.clone();
        move || {
            // Output first: it must not wait for the page, which Android is about to pause.
            crate::android_lifecycle::request_native_output_stop();
            request_dg_lifecycle_cleanup(coordinator.clone());
        }
    });

    // The app's single invoke handler, which lists these commands, lives in lib.rs.
    builder.manage(coordinator)
}

/// Stops plugin-blec before releasing its scanner claim when Android tears
/// down or suspends the WebView. Failure retains the lease, so a later scan
/// fails closed instead of starting over uncertain radio state.
// Only Android lifecycle hooks call this; host builds compile it for tests.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn request_dg_lifecycle_cleanup(coordinator: ScanCoordinator) {
    tauri::async_runtime::spawn(async move {
        let Some(lease) = coordinator.lease() else {
            return;
        };
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
    fn refuses_parallel_scans() {
        let coordinator = ScanCoordinator::default();
        let first = coordinator.try_claim().unwrap();
        assert_eq!(coordinator.try_claim(), None);
        assert!(coordinator.release(first));
        assert!(coordinator.try_claim().is_some());
    }

    #[test]
    fn stale_cleanup_cannot_release_a_newer_scan() {
        let coordinator = ScanCoordinator::default();
        let first = coordinator.try_claim().unwrap();
        assert!(coordinator.release(first));
        let second = coordinator.try_claim().unwrap();

        assert!(!coordinator.release(first));
        assert_eq!(coordinator.lease(), Some(second));
        assert!(coordinator.release(second));
        assert_eq!(coordinator.lease(), None);
    }

    #[test]
    fn release_command_rejects_a_stale_lease_and_tolerates_lifecycle_release() {
        let coordinator = ScanCoordinator::default();
        let claim = claim_dg_plugin_blec_scanner(&coordinator).unwrap();
        let stale = DgScannerReleaseRequest {
            lease_id: "999".into(),
        };
        assert!(release_dg_plugin_blec_scanner(&coordinator, stale).is_err());
        let current = DgScannerReleaseRequest {
            lease_id: claim.lease_id.clone(),
        };
        assert!(release_dg_plugin_blec_scanner(&coordinator, current).is_ok());
        let again = DgScannerReleaseRequest {
            lease_id: claim.lease_id,
        };
        assert!(release_dg_plugin_blec_scanner(&coordinator, again).is_ok());
    }
}

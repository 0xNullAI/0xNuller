use std::sync::{Arc, Mutex};

/// BLE scanner ownership shared by the experimental backend and the existing DG path.
///
/// Gate 0 only claims `Buttplug`. Before any UI enablement, the plugin-blec adapter
/// must claim `DgPluginBlec` through this same seam. Keeping the seam in Rust makes
/// simultaneous ownership impossible once that adapter is connected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ScannerOwner {
    Buttplug,
    #[allow(dead_code)] // Claimed by the unchanged DG adapter at the next integration gate.
    DgPluginBlec,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ScanCoordinator {
    owner: Arc<Mutex<Option<ScannerOwner>>>,
}

impl ScanCoordinator {
    pub(crate) fn try_claim(&self, requested: ScannerOwner) -> Result<(), ScannerOwner> {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match *owner {
            Some(current) if current != requested => Err(current),
            Some(_) => Ok(()),
            None => {
                *owner = Some(requested);
                Ok(())
            }
        }
    }

    pub(crate) fn release(&self, releasing: ScannerOwner) {
        let mut owner = self
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *owner == Some(releasing) {
            *owner = None;
        }
    }

    #[cfg(test)]
    fn owner(&self) -> Option<ScannerOwner> {
        *self
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_dual_scanner_ownership() {
        let coordinator = ScanCoordinator::default();
        coordinator.try_claim(ScannerOwner::Buttplug).unwrap();

        assert_eq!(
            coordinator.try_claim(ScannerOwner::DgPluginBlec),
            Err(ScannerOwner::Buttplug),
        );
        assert_eq!(coordinator.owner(), Some(ScannerOwner::Buttplug));
    }

    #[test]
    fn only_the_owner_can_release_the_scanner() {
        let coordinator = ScanCoordinator::default();
        coordinator.try_claim(ScannerOwner::Buttplug).unwrap();
        coordinator.release(ScannerOwner::DgPluginBlec);
        assert_eq!(coordinator.owner(), Some(ScannerOwner::Buttplug));

        coordinator.release(ScannerOwner::Buttplug);
        assert_eq!(coordinator.owner(), None);
    }
}

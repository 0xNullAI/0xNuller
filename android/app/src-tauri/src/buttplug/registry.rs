use super::schema::{
    GateError, NativeCapability, NativeDevice, MAX_DEVICES, MAX_FEATURES_PER_DEVICE,
    MAX_TOTAL_FEATURES,
};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FeatureDescriptor {
    Vibrate { step_count: u32 },
    Battery,
    Rssi,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DeviceDescriptor {
    pub index: u32,
    pub name: String,
    pub features: Vec<(u32, FeatureDescriptor)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum TelemetryValue {
    Battery(f64),
    Rssi(i16),
}

#[derive(Clone, Debug)]
struct FeatureRecord {
    id: String,
    source_index: u32,
    descriptor: FeatureDescriptor,
    telemetry: Option<TelemetryValue>,
}

#[derive(Clone, Debug)]
struct DeviceRecord {
    id: String,
    name: String,
    features: Vec<FeatureRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct VibrateTarget {
    pub device_index: u32,
    pub feature_index: u32,
    pub step_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TelemetryKind {
    Battery,
    Rssi,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TelemetryTarget {
    pub device_index: u32,
    pub device_id: String,
    pub feature_index: u32,
    pub feature_id: String,
    pub kind: TelemetryKind,
}

#[derive(Debug, Default)]
pub(super) struct ConnectionRegistry {
    devices: BTreeMap<u32, DeviceRecord>,
}

impl ConnectionRegistry {
    pub(super) fn reconcile(
        &mut self,
        descriptors: Vec<DeviceDescriptor>,
    ) -> Result<bool, GateError> {
        validate_limits(&descriptors)?;
        let incoming_indices: BTreeSet<u32> =
            descriptors.iter().map(|device| device.index).collect();
        let mut changed = false;
        self.devices.retain(|index, _| {
            let retained = incoming_indices.contains(index);
            changed |= !retained;
            retained
        });

        for descriptor in descriptors {
            let replace = self
                .devices
                .get(&descriptor.index)
                .is_none_or(|record| !same_structure(record, &descriptor));
            if replace {
                self.devices
                    .insert(descriptor.index, new_record(descriptor));
                changed = true;
            }
        }
        Ok(changed)
    }

    pub(super) fn replace_connection(
        &mut self,
        descriptor: DeviceDescriptor,
    ) -> Result<(), GateError> {
        let mut prospective = self.descriptors();
        prospective.retain(|device| device.index != descriptor.index);
        prospective.push(descriptor.clone());
        validate_limits(&prospective)?;
        self.devices
            .insert(descriptor.index, new_record(descriptor));
        Ok(())
    }

    pub(super) fn remove_connection(&mut self, index: u32) -> bool {
        self.devices.remove(&index).is_some()
    }

    pub(super) fn contains_device_id(&self, device_id: &str) -> bool {
        self.devices.values().any(|device| device.id == device_id)
    }

    pub(super) fn resolve_vibrate(
        &self,
        device_id: &str,
        feature_id: &str,
    ) -> Option<VibrateTarget> {
        self.devices.iter().find_map(|(device_index, device)| {
            if device.id != device_id {
                return None;
            }
            device.features.iter().find_map(|feature| {
                if feature.id != feature_id {
                    return None;
                }
                match feature.descriptor {
                    FeatureDescriptor::Vibrate { step_count } => Some(VibrateTarget {
                        device_index: *device_index,
                        feature_index: feature.source_index,
                        step_count,
                    }),
                    FeatureDescriptor::Battery | FeatureDescriptor::Rssi => None,
                }
            })
        })
    }

    pub(super) fn telemetry_targets(&self) -> Vec<TelemetryTarget> {
        let mut targets = Vec::new();
        for (device_index, device) in &self.devices {
            for feature in &device.features {
                let kind = match feature.descriptor {
                    FeatureDescriptor::Battery => TelemetryKind::Battery,
                    FeatureDescriptor::Rssi => TelemetryKind::Rssi,
                    FeatureDescriptor::Vibrate { .. } => continue,
                };
                targets.push(TelemetryTarget {
                    device_index: *device_index,
                    device_id: device.id.clone(),
                    feature_index: feature.source_index,
                    feature_id: feature.id.clone(),
                    kind,
                });
            }
        }
        targets
    }

    pub(super) fn update_telemetry(
        &mut self,
        target: &TelemetryTarget,
        value: Option<TelemetryValue>,
    ) {
        let Some(device) = self.devices.get_mut(&target.device_index) else {
            return;
        };
        if device.id != target.device_id {
            return;
        }
        let Some(feature) = device.features.iter_mut().find(|feature| {
            feature.id == target.feature_id && feature.source_index == target.feature_index
        }) else {
            return;
        };
        let matching_kind = matches!(
            (feature.descriptor, value),
            (
                FeatureDescriptor::Battery,
                None | Some(TelemetryValue::Battery(_))
            ) | (
                FeatureDescriptor::Rssi,
                None | Some(TelemetryValue::Rssi(_))
            )
        );
        if matching_kind {
            feature.telemetry = value;
        }
    }

    pub(super) fn topology(&self) -> Vec<NativeDevice> {
        self.devices
            .values()
            .map(|device| NativeDevice {
                native_device_id: device.id.clone(),
                name: device.name.clone(),
                capabilities: device
                    .features
                    .iter()
                    .map(|feature| match feature.descriptor {
                        FeatureDescriptor::Vibrate { step_count } => NativeCapability::Vibrate {
                            native_feature_id: feature.id.clone(),
                            step_count,
                        },
                        FeatureDescriptor::Battery => NativeCapability::Battery {
                            native_feature_id: feature.id.clone(),
                            value: match feature.telemetry {
                                Some(TelemetryValue::Battery(value)) => Some(value),
                                _ => None,
                            },
                        },
                        FeatureDescriptor::Rssi => NativeCapability::Rssi {
                            native_feature_id: feature.id.clone(),
                            value: match feature.telemetry {
                                Some(TelemetryValue::Rssi(value)) => Some(value),
                                _ => None,
                            },
                        },
                    })
                    .collect(),
            })
            .collect()
    }

    fn descriptors(&self) -> Vec<DeviceDescriptor> {
        self.devices
            .iter()
            .map(|(index, device)| DeviceDescriptor {
                index: *index,
                name: device.name.clone(),
                features: device
                    .features
                    .iter()
                    .map(|feature| (feature.source_index, feature.descriptor))
                    .collect(),
            })
            .collect()
    }
}

fn new_record(descriptor: DeviceDescriptor) -> DeviceRecord {
    DeviceRecord {
        id: Uuid::new_v4().to_string(),
        name: descriptor.name,
        features: descriptor
            .features
            .into_iter()
            .map(|(source_index, feature)| FeatureRecord {
                id: Uuid::new_v4().to_string(),
                source_index,
                descriptor: feature,
                telemetry: None,
            })
            .collect(),
    }
}

fn same_structure(record: &DeviceRecord, descriptor: &DeviceDescriptor) -> bool {
    record.name == descriptor.name
        && record.features.len() == descriptor.features.len()
        && record.features.iter().zip(&descriptor.features).all(
            |(current, (source_index, incoming))| {
                current.source_index == *source_index && current.descriptor == *incoming
            },
        )
}

fn validate_limits(descriptors: &[DeviceDescriptor]) -> Result<(), GateError> {
    if descriptors.len() > MAX_DEVICES {
        return Err(GateError::new(
            "topology_limit_exceeded",
            format!("maximum {MAX_DEVICES} supported devices exceeded"),
        ));
    }
    let mut total = 0usize;
    for device in descriptors {
        if device.features.len() > MAX_FEATURES_PER_DEVICE {
            return Err(GateError::new(
                "topology_limit_exceeded",
                format!("maximum {MAX_FEATURES_PER_DEVICE} supported features per device exceeded"),
            ));
        }
        total = total.saturating_add(device.features.len());
        if total > MAX_TOTAL_FEATURES {
            return Err(GateError::new(
                "topology_limit_exceeded",
                format!("maximum {MAX_TOTAL_FEATURES} total supported features exceeded"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(index: u32) -> DeviceDescriptor {
        DeviceDescriptor {
            index,
            name: "Test device".to_owned(),
            features: vec![
                (2, FeatureDescriptor::Vibrate { step_count: 20 }),
                (3, FeatureDescriptor::Battery),
            ],
        }
    }

    #[test]
    fn ids_are_stable_only_for_one_connection_appearance() {
        let mut registry = ConnectionRegistry::default();
        registry.reconcile(vec![descriptor(7)]).unwrap();
        let first = serde_json::to_value(registry.topology()).unwrap();

        assert!(registry.remove_connection(7));
        registry.replace_connection(descriptor(7)).unwrap();
        let second = serde_json::to_value(registry.topology()).unwrap();

        assert_ne!(first[0]["nativeDeviceId"], second[0]["nativeDeviceId"]);
        assert_ne!(
            first[0]["capabilities"][0]["nativeFeatureId"],
            second[0]["capabilities"][0]["nativeFeatureId"]
        );
        assert!(first[0].get("index").is_none());
    }

    #[test]
    fn exact_device_and_feature_pair_resolves_one_vibrator() {
        let mut registry = ConnectionRegistry::default();
        registry
            .reconcile(vec![descriptor(1), descriptor(2)])
            .unwrap();
        let topology = registry.topology();
        let device_id = &topology[0].native_device_id;
        let feature_id = match &topology[0].capabilities[0] {
            NativeCapability::Vibrate {
                native_feature_id, ..
            } => native_feature_id,
            _ => panic!("first test capability must vibrate"),
        };

        assert_eq!(
            registry.resolve_vibrate(device_id, feature_id),
            Some(VibrateTarget {
                device_index: 1,
                feature_index: 2,
                step_count: 20,
            })
        );
        assert!(registry
            .resolve_vibrate(&topology[1].native_device_id, feature_id)
            .is_none());
    }

    #[test]
    fn telemetry_refresh_does_not_change_ids_or_structure() {
        let mut registry = ConnectionRegistry::default();
        registry.reconcile(vec![descriptor(1)]).unwrap();
        let target = registry.telemetry_targets().remove(0);
        let before = registry.topology();
        registry.update_telemetry(&target, Some(TelemetryValue::Battery(0.42)));
        let after = registry.topology();

        assert_eq!(before[0].native_device_id, after[0].native_device_id);
        match &after[0].capabilities[1] {
            NativeCapability::Battery { value, .. } => assert_eq!(*value, Some(0.42)),
            _ => panic!("second test capability must be battery"),
        }
    }

    #[test]
    fn fails_closed_on_shared_runtime_topology_limits() {
        let descriptors = (0..=MAX_DEVICES as u32).map(descriptor).collect();
        let error = ConnectionRegistry::default()
            .reconcile(descriptors)
            .expect_err("nine supported devices must fail");
        assert_eq!(error.code, "topology_limit_exceeded");
    }
}

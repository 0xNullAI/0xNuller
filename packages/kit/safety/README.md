# @dg-kit/safety

The shared device safety chain for DG-Lab integrations. It provides strength and burst policy
enforcement, cold-start clamps, serialized command execution, emergency-stop preemption, device
leases, lifecycle guards, and the cross-module safety bus used by 0xNuller.

## Install

```bash
npm install @dg-kit/safety
```

Safety policy is enforced before commands reach a transport. Applications should still expose a
clear stop control and should not treat account identity as permission to control a device.

The package is ESM-only and exports its public API from the package root. Async native-write
boundaries can use `currentDeviceLeaseSnapshot()` to fence both the current module holder and its
monotonic epoch, preventing holder-name ABA after a lease transfer.

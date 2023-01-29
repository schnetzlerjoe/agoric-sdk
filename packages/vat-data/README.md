# Agoric Vat Data

This package provides access to the Vat Data facility.

## Tips

### Synchronous makers

The durable kind maker functions are synchronous. When converting a maker that is async, you'll have to ensure that all necessary data is already available and need not be awaited in the `prepare*`.

The reason for this constraint is that *all prepares happen in the first crank* of the event loop.

For any of the exo instances, remote vats may hold a capability to them. Once the successor vat-incarnation comes online, a message may arrive for any of these instances. For the instance to know how to react to the incoming message, it needs to know the code that defines its behavior. All it got from its ancestor vat-incarnation was the its data, not its code.

The successor vat-incarnation must give all outstanding exos their behaviors during the first crank, because that is guaranteed to happen before this vat-incarnation receives any messages sent to those exos.

Consider if some restoration happened in a second crank. If the restart had to wait for external deliveries, the vat would need to somehow enter a suspended state where no other deliveries than the ones needed for completion of start. And that would leave side effects experienced by other vats, so the restart/upgrade could never be fully backed out of it fails.

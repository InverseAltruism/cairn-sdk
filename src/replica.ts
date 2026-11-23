// @inversealtruism/cairn-sdk/replica: the replica package's browser entry, re-exported whole, so that an app reads
// one vocabulary (the verdict codes NOT_VERIFIED_CODES and NOTE_CODES, levelOf, proofOf, the answer types) and opens
// a replica from the SDK. Nothing is restated here. @inversealtruism/cairnx-replica is an optional peer: only an app
// that imports this entry installs it, and no other entry of this package imports it.
export * from "@inversealtruism/cairnx-replica/browser";

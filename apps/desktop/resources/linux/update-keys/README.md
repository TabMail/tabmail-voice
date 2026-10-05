# Linux update keys

The Ed25519 public keys (PEM, `*.pem`) a Linux update's signature must verify with (ADR-DESK-050).
`install-update` reads them from beside itself, root-owned, in the installed package; the app turns
Linux updates on only when at least one is here. The private key never enters this repository: the
release signs each feed with it. To replace a key, ship the new one beside the old in one release,
sign with the new one from the next, and drop the old one in the release after that.

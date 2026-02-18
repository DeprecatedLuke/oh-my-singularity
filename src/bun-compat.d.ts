// Bun's Response supports .bytes() but the undici-types BodyMixin
// (used by bun-types when lib "DOM" is absent) doesn't declare it.
// tsgo resolves this differently, so oh-my-pi compiles clean.
interface Response {
	bytes(): Promise<Uint8Array>;
}

/**
 * Shared filters for CLI / app-server stderr lines that should not spam the web transcript.
 */

/** Strip ANSI SGR / OSC sequences so pattern matching works on colored Rust/Go logs. */
export function stripAnsi(text: string): string {
  return String(text || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

/**
 * Codex app-server (and some embedded Codex bits) call GET /v1/models on custom
 * gateways that return OpenAI `{"data":[...]}`. Codex expects `{"models":[...]}`,
 * logs ERROR, then keeps working from models_cache.json. Harmless but noisy —
 * and because app-server stays alive, these lines used to leak into every engine's turn.
 */
export function isCodexModelsManagerNoise(line: string): boolean {
  const value = stripAnsi(line);
  return /codex_models_manager|failed to refresh available models|failed to decode models response|missing field [`']?models[`']?/i.test(value);
}

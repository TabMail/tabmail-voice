// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.


import * as config from "../config.js";
import { BackendError, errorCode } from "./errors.js";
import { BackendLog, type HTTPRequest, type HTTPTransport, joinURL, requestHeaders } from "./http.js";
import { elapsed, log } from "../log.js";
import { base64 } from "../util/text.js";

/** The variables of the backend's cleanup prompt other than the transcript, which the backend fills in
 * (backend ADR-027). */
export interface CleanupVariables {
  app_name: string;
  web_host: string;
  terminal_program: string;
  window_title: string;
  screen_text: string;
  dictionary: string;
}

/** A recording's transcript and, when the request asked for it, the backend's cleanup of it: empty
 * when the cleanup failed or ran out of time, null when not asked for or not returned. */
export interface Transcription {
  text: string;
  cleanedText: string | null;
}

/** Calls the TabMail backend's `POST /dictation/transcribe` (OpenRouter STT behind it). */
export class TranscriptionClient {
  constructor(
    readonly baseURL: string,
    readonly clientVersion: string,
    private readonly transport: HTTPTransport,
  ) {}

  /** `language`: the keyboard's at key-down, which picks the backend's model; null sends none (the
   * default model). `vocabulary`: the user's dictionary words, which the speech model favors
   * (ADR-DESK-038); none are sent when it is empty. `cleanup`: the cleanup's variables, for the backend
   * to clean up the transcript in the same request (ADR-DESK-008); none for no cleanup. */
  async transcribe(
    flac: Uint8Array,
    language: string | null,
    vocabulary: readonly string[],
    accessToken: string,
    signal?: AbortSignal,
    cleanup?: CleanupVariables,
  ): Promise<Transcription> {
    const request: HTTPRequest = {
      method: "POST",
      url: joinURL(this.baseURL, config.transcribePath),
      timeout: config.transcriptionRequestTimeout,
      headers: requestHeaders(accessToken, this.clientVersion),
      body: JSON.stringify(TranscriptionClient.body(base64(flac), language, vocabulary, cleanup)),
      signal,
    };
    log.content("Transcription request", () => BackendLog.request(request, TranscriptionClient.loggedBody(flac.length, language, vocabulary, cleanup)));
    const sent = performance.now();
    const response = await this.transport(request);
    log.debug(() => `Transcription: HTTP ${response.status} in ${elapsed(sent)}`);
    log.content("Transcription response", () => BackendLog.response(response));
    if (response.status !== 200) throw BackendError.fromStatus(response.status, errorCode(response.body));
    let result: unknown;
    try {
      result = JSON.parse(response.body);
    } catch {
      throw new BackendError("invalidResponse");
    }
    if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") {
      throw new BackendError("invalidResponse");
    }
    const cleanedText = "cleaned_text" in result ? result.cleaned_text : null;
    if (cleanedText !== null && typeof cleanedText !== "string") throw new BackendError("invalidResponse");
    return { text: result.text, cleanedText };
  }

  /** `GET /whoami` with the sign-in, its reply unread. Sent at key-down, while the user speaks, it
   * opens the connection and has the backend verify the token and load the entitlement, so the
   * transcription after the release finds them ready: the first dictation after a pause otherwise
   * waited about 0.3 s longer for them. */
  async warmUp(accessToken: string): Promise<void> {
    const request: HTTPRequest = {
      method: "GET",
      url: joinURL(this.baseURL, config.warmUpPath),
      timeout: config.warmUpRequestTimeout,
      headers: requestHeaders(accessToken, this.clientVersion),
      body: "",
    };
    log.content("Warm-up request", () => BackendLog.request(request));
    const response = await this.transport(request);
    log.content("Warm-up response", () => BackendLog.response(response));
    if (response.status !== 200) throw BackendError.fromStatus(response.status, errorCode(response.body));
  }

  /** The request body as the log shows it: the audio's size in its place, never the audio. */
  static loggedBody(flacBytes: number, language: string | null, vocabulary: readonly string[], cleanup?: CleanupVariables): string {
    return JSON.stringify(TranscriptionClient.body(`<${flacBytes} bytes of FLAC, not logged>`, language, vocabulary, cleanup));
  }

  /** `language` is left out when null, `vocabulary` when empty, `cleanup` when undefined. */
  private static body(audio: string, language: string | null, vocabulary: readonly string[], cleanup: CleanupVariables | undefined): Record<string, unknown> {
    return {
      audio,
      format: "flac",
      ...(language === null ? {} : { language }),
      ...(vocabulary.length === 0 ? {} : { vocabulary }),
      ...(cleanup === undefined ? {} : { cleanup }),
    };
  }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
#ifndef TABMAIL_VOICE_CORE_H
#define TABMAIL_VOICE_CORE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Callers own their input, which must be readable for length bytes, and provide
 * a distinct writable output slot. The library retains no input after return.
 * Output is UTF-8 JSON, not NUL terminated. Free a successful output once.
 * Status: 0 success, 1 invalid request, 2 panic/refusal, 3 internal refusal.
 * Every nonzero status leaves an empty output; never fall back to raw input. */
typedef struct { uint8_t *data; size_t length; } VoiceCoreBuffer;
uint32_t voice_core_abi_version(void);
uint32_t voice_core_redact_json(const uint8_t *data, size_t length, VoiceCoreBuffer *output);
uint32_t voice_core_viewport_json(const uint8_t *data, size_t length, VoiceCoreBuffer *output);
uint32_t voice_core_context_json(const uint8_t *data, size_t length, VoiceCoreBuffer *output);
uint32_t voice_core_policy_json(const uint8_t *data, size_t length, VoiceCoreBuffer *output);
uint32_t voice_core_address_json(const uint8_t *data, size_t length, VoiceCoreBuffer *output);
void voice_core_buffer_free(VoiceCoreBuffer buffer);
/* Semantic text ABI. One policy for all platforms; no platform-selected limits.
 * Kinds: 1 row, 2 heading, 3 link. Decisions: 1 read approved root, 2 read
 * approved descendants, 3 complete, 4 presentation budget full (stop reading).
 * Events: 1 root, 2 descendant, 3 descendants complete, 4 traversal interrupted.
 * End events carry no text. Invalid text or events poison the handle. Inputs
 * must be valid UTF-8, <=256 KiB per fragment; no input pointer is retained.
 * Handles are exclusive owners: free once; no concurrent calls or copied owners.
 * Finish returns SOURCE text, retaining the complete last fragment for combined
 * redaction. Never expose it before shared screen redaction/presentation limiting.
 * It is not NUL terminated; free with voice_core_buffer_free. */
typedef struct VoiceSemanticText VoiceSemanticText;
uint32_t voice_core_semantic_new(uint32_t kind, VoiceSemanticText **output, uint32_t *decision);
uint32_t voice_core_semantic_offer(VoiceSemanticText *state, uint32_t event, const uint8_t *data, size_t length, uint32_t *decision);
uint32_t voice_core_semantic_finish(const VoiceSemanticText *state, VoiceCoreBuffer *output);
/* Projected offers use JSON [private-before, visible, private-after].
 * Projected finish returns private {text,runs}, where runs are [text,visible].
 * Once projected source is accepted, legacy string finish refuses. Pass the
 * mapped result through admitSemantic and final context redaction; never publish
 * runs. Invalid JSON/metadata poisons the owner. */
uint32_t voice_core_semantic_offer_projected(VoiceSemanticText *state, uint32_t event, const uint8_t *data, size_t length, uint32_t *decision);
uint32_t voice_core_semantic_finish_projected(const VoiceSemanticText *state, VoiceCoreBuffer *output);
void voice_core_semantic_free(VoiceSemanticText *state);

/* Bounded native source acquisition. Exclusive handles: free once, no copied owners or
 * concurrent calls. Native adapters retain provider identity/privacy/deadline checks.
 * The constructors take counts/endpoints in UTF-16 units or Unicode scalars.
 * next returns a start/length in those native units (<=4096); zero means complete.
 * utf16_offer accepts exactly that many aligned uint16_t units, including split
 * surrogate pairs. utf8_offer accepts valid UTF-8 encoding exactly that many
 * scalars (<=16384 bytes). Offers must match the constructor's encoding.
 * Invalid offers poison the handle. No input pointer is retained.
 * finish requires completion and returns private caretWindow JSON source; pass it
 * through combined screen redaction before publication. Free its buffer normally.
 * Output slots must be writable, distinct and nonoverlapping with input/handle. */
typedef struct VoiceSource VoiceSource;
uint32_t voice_core_source_utf16_new(size_t count, size_t start, size_t end, VoiceSource **output);
uint32_t voice_core_source_scalar_new(size_t count, size_t start, size_t end, VoiceSource **output);
/* Field owners read only [start,end), using the common field byte allowance.
 * finish returns {text,complete}; complete describes acquisition of the requested
 * interval, not the whole document. Unknown document edges are withheld by Rust.
 * For a whole-field attempt, incomplete means request native visible ranges.
 * The returned text is private recognition source, still requiring redaction. */
/* Ordinary text/name source uses the shared final-block allowance rather than
 * the smaller semantic-fragment/field allowance. Same finish protocol/ownership. */
uint32_t voice_core_block_utf16_new(size_t count, size_t start, size_t end, VoiceSource **output);
uint32_t voice_core_block_scalar_new(size_t count, size_t start, size_t end, VoiceSource **output);
uint32_t voice_core_field_utf16_new(size_t count, size_t start, size_t end, VoiceSource **output);
uint32_t voice_core_field_scalar_new(size_t count, size_t start, size_t end, VoiceSource **output);
/* Visible-field owners also acquire bounded adjacent recognition source.
 * finish returns {parts:[before,visible,after],complete}; pass all parts to
 * admitField / the block source property. Never render or strip the sides before
 * combined redaction. An omitted visible tail never joins nonadjacent after text. */
uint32_t voice_core_visible_field_utf16_new(size_t count, size_t start, size_t end, VoiceSource **output);
uint32_t voice_core_visible_field_scalar_new(size_t count, size_t start, size_t end, VoiceSource **output);
uint32_t voice_core_source_next(const VoiceSource *state, size_t *start, size_t *length);
uint32_t voice_core_source_utf16_offer(VoiceSource *state, const uint16_t *data, size_t length);
uint32_t voice_core_source_utf8_offer(VoiceSource *state, const uint8_t *data, size_t length);
uint32_t voice_core_source_finish(const VoiceSource *state, VoiceCoreBuffer *output);
void voice_core_source_free(VoiceSource *state);

/* Gesture ABI: zero-initialize state, then set durations and chatOpen. All fields
 * have value semantics; internal fields are reserved to the core. Caller holds
 * exclusive access during mutation. No allocation, callbacks, or retained pointers.
 * Keys: 0 other, 1 Space, 2 Escape. Actions: 0 none, otherwise VoiceGestureAction.
 * Ownership is queried BEFORE dispatching key-down; native monitors own key-up
 * suppression and platform key filtering. Invalid scalar events do not mutate. */
typedef struct {
    double tapMaxDuration, doubleTapWindow, pressedAt, lastTapReleasedAt, handsFreeReleasedAt;
    uint32_t holding, handsFree, chatOpen, holdOver, doubleTap, hasLastTap, hasHandsFreeTap;
} VoiceGestureState;
enum VoiceGestureAction {
    VoiceGestureStart = 1, VoiceGestureStartHandsFree = 2,
    VoiceGestureStartAgent = 3, VoiceGestureStartAgentHandsFree = 4,
    VoiceGestureListenHandsFree = 5, VoiceGestureFinish = 6, VoiceGestureCancel = 7,
    VoiceGestureToggleMode = 8, VoiceGestureCloseChat = 9, VoiceGestureShowHistory = 10
};
uint32_t voice_core_gesture_modifier(VoiceGestureState *state, uint32_t down, double time, uint32_t agent);
uint32_t voice_core_gesture_key(VoiceGestureState *state, uint32_t key, uint32_t repeat);
uint32_t voice_core_gesture_owns(const VoiceGestureState *state, uint32_t key);
void voice_core_gesture_ended(VoiceGestureState *state);

#ifdef __cplusplus
}
#endif
#endif

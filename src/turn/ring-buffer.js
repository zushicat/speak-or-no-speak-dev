/**
 * WP0 placeholder — ring buffer for pre-speech padding lands in WP3/WP4.
 *
 * Keeps `preSpeechPadMs` (200 ms default) of audio before onset so
 * onTurnEnd(audio) never clips the first syllable.
 */
export {};

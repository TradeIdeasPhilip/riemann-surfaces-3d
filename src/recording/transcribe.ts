import { makeTranscript } from "canvas-recorder-lib/dev/transcripts";

/**
 * Transcribe a take, word by word, with the video editor library's transcriber.  The times are in ms
 * from the start of the file.  Give it a URL the page can fetch, like "/recordings/take ….wav" from
 * the dev server.  For scripts, for now:  the panel doesn't use this yet.
 */
export async function transcribeTake(url: string) {
  return makeTranscript(url);
}

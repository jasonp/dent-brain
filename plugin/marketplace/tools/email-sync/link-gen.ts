/**
 * Gmail deep link generation.
 *
 * Per gbrain's `recipes/email-to-brain.md`: this MUST be code, never an LLM.
 * Format:
 *   https://mail.google.com/mail/u/?authuser=ACCOUNT#inbox/MESSAGE_ID
 *
 * The `authuser` parameter is critical. Without it, the link opens in
 * whichever Gmail account is the browser default — which for users with
 * multiple accounts is ~50% of the time the WRONG one. authuser is a
 * positional index ("0", "1", ...) corresponding to the order accounts
 * are signed into mail.google.com.
 */

export function gmailLink(messageId: string, authUser: string = '0'): string {
  if (!messageId) throw new Error('gmailLink: missing messageId');
  // No URL encoding needed — Gmail message ids are alphanumeric, authuser is a digit.
  return `https://mail.google.com/mail/u/?authuser=${authUser}#inbox/${messageId}`;
}

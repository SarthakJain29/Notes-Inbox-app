export interface Button {
  label: string;
  /** Callback payload (<= 64 bytes for Telegram). */
  data: string;
}

/** Transport-neutral response. `text` is Telegram-flavoured HTML (<b>, <i>, <code>, <a>). */
export interface Reply {
  text: string;
  buttons?: Button[][];
  /** Optional file to send (used by /export). */
  document?: { filename: string; content: string };
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render Telegram HTML as readable plain text (CLI). */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

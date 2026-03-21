import { splitMessage } from '../../core/message-formatter.js';

const MAX_LENGTH = 4096;

/**
 * Characters that must be escaped with `\` in Telegram MarkdownV2 plain text.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
const RESERVED_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;

function escapeReserved(text: string): string {
  return text.replace(RESERVED_RE, '\\$&');
}

/**
 * Convert a Markdown string to Telegram MarkdownV2 format.
 *
 * Strategy: extract code spans/blocks and formatting constructs into
 * protected "slots", then escape all remaining plain text, then restore slots.
 */
export function toMarkdownV2(markdown: string): string {
  const slots: string[] = [];

  function protect(s: string): string {
    slots.push(s);
    return `\x00${slots.length - 1}\x00`;
  }

  let out = markdown;

  // 1. Fenced code blocks — escape only ` and \ inside
  out = out.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_full, lang: string, code: string) => {
    const safe = code.replace(/[\\`]/g, '\\$&');
    return protect(lang ? `\`\`\`${lang}\n${safe}\`\`\`` : `\`\`\`\n${safe}\`\`\``);
  });

  // 2. Inline code — escape only ` and \ inside
  out = out.replace(/`([^`\n]+)`/g, (_full, code: string) => {
    const safe = code.replace(/[\\`]/g, '\\$&');
    return protect(`\`${safe}\``);
  });

  // 3. Links [text](url) — escape link text normally, URL only escapes ) and \
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_full, linkText: string, url: string) => {
    return protect(`[${escapeReserved(linkText)}](${url.replace(/[)\\]/g, '\\$&')})`);
  });

  // 4. Headings → bold line (strip # prefix)
  out = out.replace(/^#{1,6} (.+)$/gm, (_full, headText: string) => {
    return protect(`*${escapeReserved(headText)}*`);
  });

  // 5. Bold **text** → *text*
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_full, boldText: string) => {
    return protect(`*${escapeReserved(boldText)}*`);
  });

  // 6. Strikethrough ~~text~~ → ~text~
  out = out.replace(/~~([^~\n]+)~~/g, (_full, text: string) => {
    return protect(`~${escapeReserved(text)}~`);
  });

  // 7. Italic _text_ — negative lookahead/behind to avoid __word__
  out = out.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, (_full, text: string) => {
    return protect(`_${escapeReserved(text)}_`);
  });

  // 8. Split remaining text on slot markers; escape the plain-text parts
  const parts = out.split(/(\x00\d+\x00)/);
  return parts
    .map((part) => {
      const slotMatch = /^\x00(\d+)\x00$/.exec(part);
      if (slotMatch) {
        return slots[parseInt(slotMatch[1]!, 10)] ?? '';
      }
      return escapeReserved(part);
    })
    .join('');
}

export class TelegramFormatter {
  format(markdown: string): string {
    return toMarkdownV2(markdown);
  }

  formatAndSplit(markdown: string): string[] {
    return splitMessage(this.format(markdown), MAX_LENGTH);
  }
}

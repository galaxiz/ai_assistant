import { splitMessage } from '../../core/message-formatter.js';

const MAX_BLOCK_LENGTH = 3000;

export interface SlackSectionBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
}

/**
 * Convert Markdown to Slack mrkdwn format.
 *
 * Slot-based approach identical to the Telegram formatter: extract constructs
 * into protected placeholders, then restore them after the regex pipeline,
 * preventing later regexes from double-transforming earlier matches.
 */
export function toMrkdwn(markdown: string): string {
  const slots: string[] = [];

  function protect(s: string): string {
    slots.push(s);
    return `\x00${slots.length - 1}\x00`;
  }

  let out = markdown;

  // 1. Fenced code blocks — strip language hint (Slack doesn't render it)
  out = out.replace(/```[\w]*\n?([\s\S]*?)```/g, (_full, code: string) => {
    return protect(`\`\`\`\n${code.trim()}\n\`\`\``);
  });

  // 2. Inline code — unchanged in mrkdwn
  out = out.replace(/`([^`\n]+)`/g, (_full, code: string) => {
    return protect(`\`${code}\``);
  });

  // 3. Links [text](url) → <url|text>
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_full, text: string, url: string) => {
    return protect(`<${url}|${text}>`);
  });

  // 4. Headings → *Heading*
  out = out.replace(/^#{1,6} (.+)$/gm, (_full, text: string) => {
    return protect(`*${text}*`);
  });

  // 5. Bold **text** → *text* (protect before italic so *text* isn't re-matched)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_full, text: string) => {
    return protect(`*${text}*`);
  });

  // 6. Strikethrough ~~text~~ → ~text~
  out = out.replace(/~~([^~\n]+)~~/g, (_full, text: string) => {
    return protect(`~${text}~`);
  });

  // 7. Italic *text* → _text_ (Slack bold is *, Slack italic is _)
  out = out.replace(/\*([^*\n]+)\*/g, (_full, text: string) => {
    return protect(`_${text}_`);
  });

  // 8. Restore slots — plain text segments need no escaping in mrkdwn
  const parts = out.split(/(\x00\d+\x00)/);
  return parts
    .map((part) => {
      const m = /^\x00(\d+)\x00$/.exec(part);
      if (m) return slots[parseInt(m[1]!, 10)] ?? '';
      return part;
    })
    .join('');
}

export function toSlackBlocks(markdown: string): SlackSectionBlock[] {
  const mrkdwn = toMrkdwn(markdown);
  const chunks = splitMessage(mrkdwn, MAX_BLOCK_LENGTH);
  return chunks.map((text) => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  }));
}

export class SlackFormatter {
  format(markdown: string): string {
    return toMrkdwn(markdown);
  }

  formatAsBlocks(markdown: string): SlackSectionBlock[] {
    return toSlackBlocks(markdown);
  }
}

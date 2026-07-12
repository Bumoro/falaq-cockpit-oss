// prompt-reader.js — read a Claude Code TUI prompt out of a captured tmux pane and describe it as
// structured, answerable options. Pure, zero-deps, never throws; an unrecognized screen -> kind:'none'.
//
// SAFETY-CRITICAL: tapping a rendered option sends its KEY (a digit) to the real session, so a parsed
// label and key must NEVER disagree with the real on-screen menu — else a benign-looking button could
// select a destructive option (e.g. "Yes, and don't ask again"). The captured pane routinely contains
// numbered PROSE (Claude's own answer, "1. Delete / 2. Keep") ABOVE the real menu, sometimes with no
// separating line. We therefore identify the menu by STRUCTURE, not position:
//   * A menu is a run of option lines whose keys STRICTLY INCREMENT (1,2,3,…). Numbered prose above a
//     menu forms a SEPARATE run because the menu re-starts numbering at 1 — a reset ends the prose run.
//     So prose labels can never land on the menu's keys, even when contiguous.
//   * We accept only a run that carries the live selection cursor (❯/›), starts at option 1, and has
//     >=2 options — then take the LAST such run (the menu sits at the bottom of the frame).
//   * The cursor is ❯/› only. '>' is NOT a cursor: it collides with markdown blockquotes / quoted text
//     ("> 1. …"), which would fabricate a menu from prose.
// A parse miss yields kind:'none' (no buttons; the operator opens the panel) — always the safe fallback.

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;               // CSI/SGR escape sequences (capture-pane -e)
const CURSOR_RE = /^\s*[❯›]/;                               // real Claude selection cursor (NOT '>')
const OPTION_RE = /^\s*[❯›]?\s*([1-9])[.)]\s+(.+?)\s*$/;    // "❯ 1. Yes"  or  "2) No"
const ASK_RE = /Do you want to|Would you like|Which |Choose |Select |proceed\??|\?\s*$/i;

function stripAnsi(s) { return String(s == null ? '' : s).replace(ANSI_RE, ''); }
function clean(s) { return stripAnsi(s).replace(/\s*\(esc\)\s*$/i, '').replace(/\s+/g, ' ').trim(); }

// parsePrompt(text) -> { kind:'permission'|'choice'|'none', title, options:[{label,key}] }
function parsePrompt(text) {
  const none = { kind: 'none', title: '', options: [] };
  if (!text || typeof text !== 'string') return none;
  const lines = text.split('\n');

  const runs = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = stripAnsi(lines[i]);
    const m = raw.match(OPTION_RE);
    if (m) {
      const key = m[1];
      const prev = cur && cur.opts.length ? Number(cur.opts[cur.opts.length - 1].key) : 0;
      if (!cur || Number(key) !== prev + 1) {        // menu start, or a numbering reset/gap -> new run
        cur = { start: i, opts: [], cursor: false };
        runs.push(cur);
      }
      cur.opts.push({ key, label: clean(m[2]) });
      if (CURSOR_RE.test(raw)) cur.cursor = true;
    } else if (cur && /^\s+\S/.test(raw)) {
      // an INDENTED non-option line is a wrapped continuation of the previous option's label:
      // keep the run open (don't add an option). A flush-left or blank line still ends the run.
    } else {
      cur = null;
    }
  }

  // The real menu: the LAST run that carries the cursor, starts at option 1, and has >=2 options.
  let menu = null;
  for (const r of runs) if (r.cursor && r.opts.length >= 2 && r.opts[0].key === '1') menu = r;
  if (!menu) return none;

  // Title = nearest question line just ABOVE the menu run; stop at an earlier option line.
  let title = '';
  for (let i = menu.start - 1; i >= 0 && i >= menu.start - 6; i--) {
    if (OPTION_RE.test(stripAnsi(lines[i]))) break;
    const t = clean(lines[i]);
    if (t && ASK_RE.test(t)) { title = t; break; }
  }
  const first = menu.opts[0].label.toLowerCase();
  const kind = /^(yes|allow|proceed|approve)/.test(first) ? 'permission' : 'choice';
  return { kind, title: title || (kind === 'permission' ? 'Approve this action?' : 'Choose an option'), options: menu.opts };
}

module.exports = { parsePrompt };

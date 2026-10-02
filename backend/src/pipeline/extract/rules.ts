import { PFlow, PNode, ProcessModel, TaskKind } from '../types';
import { clip, normalizeModel, similarity, titleCase } from '../model-utils';

/**
 * Deterministic, dependency-free extractor. It is the offline fallback used when no
 * open-source LLM (Ollama / vLLM) is reachable, so the product always produces a diagram.
 * It handles: numbered/bulleted SOPs, prose, actors ("The manager approves ..."),
 * passive voice ("... is reviewed by Finance"), decisions (If / Otherwise), terminal
 * branches (rejects ... process ends), loops ("go back to ...") and parallel work
 * ("Meanwhile ...", "simultaneously").
 */

const BASE_VERBS = `submit review approve reject send check verify validate create prepare fill complete
notify inform update record log enter file archive pay process issue sign collect receive request
assign schedule escalate resolve close open register upload download compare calculate confirm
analyze analyse inspect test deploy publish ship deliver pack order purchase book reserve cancel
decline deny accept return refund transfer forward route attach print scan email call contact
interview hire onboard train evaluate score rank decide determine approve examine audit monitor
generate produce draft write edit revise merge release plan prioritize prioritise discuss present
share provide give take make perform handle manage define document capture identify select choose
add remove delete mark flag tag move copy store save sync import export convert apply grant revoke
reset activate deactivate provision configure install setup renew extend terminate settle invoice
bill charge quote negotiate follow track measure report resubmit reopen reassign assess investigate
organize organise coordinate arrange allocate dispatch pick label authorise authorize reconcile
countersign stamp notarize screen shortlist offer welcome introduce brief kick release lodge
raise log diagnose repair fix replace refer hand collect gather obtain research read learn`
  .split(/\s+/)
  .filter(Boolean);

const IRREGULAR: Record<string, string> = {
  sent: 'send', made: 'make', paid: 'pay', held: 'hold', gave: 'give', took: 'take', got: 'get',
  found: 'find', kept: 'keep', wrote: 'write', built: 'build', chose: 'choose', sold: 'sell',
  began: 'begin', ran: 'run', read: 'read', put: 'put', set: 'set', told: 'tell', met: 'meet',
};

const VERB_FORMS = new Map<string, string>();
(function buildForms() {
  const add = (form: string, base: string) => VERB_FORMS.set(form, base);
  for (const v of BASE_VERBS) {
    add(v, v);
    add(/(s|x|z|ch|sh|o)$/.test(v) ? v + 'es' : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + 'ies' : v + 's', v);
    add(v.endsWith('e') ? v + 'd' : /[^aeiou]y$/.test(v) ? v.slice(0, -1) + 'ied' : v + 'ed', v);
    add(v.endsWith('e') ? v.slice(0, -1) + 'ing' : v + 'ing', v);
  }
  for (const [form, base] of Object.entries(IRREGULAR)) {
    add(form, base);
    add(base + 's', base);
  }
  ['get', 'set', 'put', 'hold', 'keep', 'give', 'take', 'make', 'send', 'pay', 'run', 'find'].forEach((v) => {
    VERB_FORMS.set(v, v);
    VERB_FORMS.set(/(s|x|z|ch|sh)$/.test(v) ? v + 'es' : v + 's', v);
  });
  ['is', 'are', 'was', 'were', 'be', 'been', 'being'].forEach((w) => VERB_FORMS.delete(w));
})();

const MODALS = new Set([
  'must', 'should', 'will', 'shall', 'can', 'may', 'could', 'would', 'then', 'also', 'next', 'finally',
  'first', 'subsequently', 'afterwards', 'automatically', 'manually', 'immediately', 'again', 'later',
  'always', 'typically', 'usually', 'just', 'now', 'needs', 'need', 'has', 'have', 'to', 'is', 'are',
  'do', 'does', 'not', 'further',
]);
const PRONOUNS = new Set(['it', 'they', 'he', 'she', 'who', 'this', 'that', 'we', 'i', 'you']);
const SYSTEM_RE = /\b(system|platform|api|bot|software|server|erp|crm|application|app|workflow engine|service|automation|database)\b/i;
const TERMINAL_VERB_RE = /\b(reject|rejects|rejected|decline|declines|declined|deny|denies|denied|cancel|cancels|cancelled|canceled|terminate|terminates|terminated|abort|aborts|aborted)\b/i;
const PURE_END_RE = /^(?:the\s+)?(?:process|workflow|case|request|ticket|flow)\s+(?:ends?|terminates?|stops?|is\s+(?:closed|complete|completed|finished|terminated|ended))$|^(?:end|stop|finish)(?:\s+the\s+(?:process|workflow))?$/i;
const PURE_CONT_RE = /^(?:the\s+)?(?:process|workflow|flow|case)\s+(?:continues?|proceeds?|moves\s+on|carries\s+on)$|^(?:continue|proceed|nothing\s+(?:happens|further))$/i;
const PARALLEL_MARK_RE = /\b(in parallel|simultaneously|at the same time|concurrently)\b/i;
const PARALLEL_START_RE = /^(?:meanwhile|at the same time|in parallel|simultaneously|concurrently)\b[,:]?\s*/i;
const ELSE_RE = /^(?:otherwise|else|if not|if\s+(?:it|this|that|the\s+\w+(?:\s+\w+)?)\s+(?:is|are)\s+not\s+\w+|in all other cases|if\s+(?:rejected|denied|declined|invalid|incomplete|unsuccessful|not approved|not valid))\b[,:]?\s*/i;
const COND_RE = /^(if|in case(?: of)?|in the event(?: that| of)?|whenever|unless|should|when)\b[,:]?\s+(.+?),\s*(?:then\s+)?(.+)$/i;
const BACK_RE = /(?:go(?:es)?\s+back\s+to|back\s+to|return(?:s|ed)?\s+(?:(?:it|them|this|the\s+\w+)\s+)?to|restart(?:s)?\s+from|repeat(?:s)?\s+from|loops?\s+back\s+to)\s+(?:the\s+)?(?:step\s+)?(.+)$/i;

type Step =
  | { kind: 'task'; clauses: string[] }
  | { kind: 'cond'; cond: string; invert: boolean; clauses: string[] }
  | { kind: 'else'; clauses: string[] }
  | { kind: 'par'; branches: string[][] };

interface Parsed {
  object?: string;
  actor?: string;
  name: string;
  terminal?: boolean;
  endLabel?: string;
  backTo?: string;
  pureEnd?: boolean;
}

/* ------------------------------------------------------------------ text handling */

function stripBullet(line: string): string {
  return line
    .replace(/^\s*(?:[-*•–]|\d+[.)]|[a-z][.)]|step\s*\d+\s*[:.\-)]?)\s+/i, '')
    .replace(/^\s*#+\s*/, '')
    .trim();
}

function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?;])\s+(?=[A-Z"'(])/)
    .map((s) => s.replace(/[.!?;]+$/, '').trim())
    .filter(Boolean);
}

function looksLikeHeading(line: string): boolean {
  const t = line.replace(/^#+\s*/, '').trim();
  if (!t) return false;
  if (/^#/.test(line) || /^(title|process|sop|procedure|workflow)\s*[:\-]/i.test(t)) return true;
  if (/[.!?:,]$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 8 || /[,;]/.test(t)) return false;
  // a heading is a short noun phrase: no inflected verb form in it
  return !words.some((w, i) => i > 0 && baseOf(w) !== undefined && baseOf(w) !== w.toLowerCase() && !/ing$/i.test(w));
}

const END_CLAUSE_AFTER_AND = /\s+and\s+(?=(?:the\s+)?(?:process|workflow|case)\s+(?:ends?|terminates?|stops?|is\s+(?:closed|complete|completed|finished|terminated)))/i;

/** Position of an " and " that starts a new clause (own verb, optionally with own subject). */
function splitAtAnd(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  const re = /\s+and\s+/gi;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(rest))) {
    const tail = rest.slice(m.index + m[0].length).split(/\s+/);
    let j = -1;
    for (let i = 0; i < Math.min(tail.length, 4); i++) {
      const w = tail[i].toLowerCase().replace(/[^a-z]/g, '');
      const b = baseOf(w);
      if (b && b !== w) {
        j = i;
        break;
      }
      if (b && i === 0) break; // base-form verb right after "and" is an object noun ("checks X and review notes")
    }
    if (j >= 0) {
      parts.push(rest.slice(last, m.index));
      last = m.index + m[0].length;
    }
  }
  parts.push(rest.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitClauses(text: string): string[] {
  const first = text
    .replace(END_CLAUSE_AFTER_AND, ', then ')
    .split(/\s*(?:,\s*(?:and\s+)?then\b|;\s*then\b|\band\s+then\b|\bthen\b,?|\bafterwards?\b,?|;)\s*/i)
    .map((c) => c.trim().replace(/^(?:and|,)\s+/i, '').trim())
    .filter(Boolean);
  return first.flatMap(splitAtAnd);
}

function stripLeadIn(s: string): string {
  let t = s.trim();
  t = t.replace(/^(?:first(?:ly)?|next|then|finally|lastly|afterwards?|subsequently|also|additionally|thereafter)\b[,:]?\s*/i, '');
  t = t.replace(/^(?:after that|once that is done|following that|at this point)\b[,:]?\s*/i, '');
  const m = t.match(/^(?:once|after|upon|following)\b[^,]{1,80},\s*(.+)$/i);
  if (m) t = m[1];
  return t.trim();
}

/* ------------------------------------------------------------------ step parsing */

function parseSteps(text: string): { title?: string; trigger?: string; steps: Step[] } {
  const lines = text
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  let title: string | undefined;
  if (lines.length > 1 && looksLikeHeading(lines[0])) {
    title = lines[0].replace(/^#+\s*/, '').replace(/^(title|process|sop|procedure|workflow)\s*[:\-]\s*/i, '').trim();
    lines.shift();
  }

  const sentences: string[] = [];
  for (const line of lines) {
    const bare = stripBullet(line);
    if (!bare || /:$/.test(bare) || /^(purpose|scope|roles?|responsibilities|notes?|agenda|attendees|participants)\s*:/i.test(bare) && bare.length < 120 && !/\b(approve|submit|review)s?\b/i.test(bare)) continue;
    sentences.push(...splitSentences(bare));
  }

  let trigger: string | undefined;
  const steps: Step[] = [];

  sentences.forEach((raw, idx) => {
    let s = raw.trim();

    // Trigger sentence: "When a customer places an order, the sales team ..."
    if (idx === 0) {
      const t = s.match(/^(?:when|once|after|upon)\s+(.+?),\s*(.+)$/i);
      if (t) {
        trigger = clip(t[1].replace(/^(?:a|an|the)\s+/i, ''), 50);
        s = t[2];
      }
    }

    const par = s.match(PARALLEL_START_RE);
    if (par) {
      const rest = s.slice(par[0].length);
      const prev = steps[steps.length - 1];
      if (prev && prev.kind === 'task') {
        steps[steps.length - 1] = { kind: 'par', branches: [prev.clauses.slice(-1), splitClauses(rest)] };
        if (prev.clauses.length > 1) {
          steps.splice(steps.length - 1, 0, { kind: 'task', clauses: prev.clauses.slice(0, -1) });
        }
        return;
      }
      if (prev && prev.kind === 'par') {
        prev.branches.push(splitClauses(rest));
        return;
      }
      s = rest;
    }

    const wh = s.match(/^(.+?)\s+(?:while|whilst|and meanwhile|and at the same time|and simultaneously)\s+(.+)$/i);
    if (wh && !/^(?:if|when)\b/i.test(s)) {
      steps.push({ kind: 'par', branches: [splitClauses(wh[1]), splitClauses(wh[2])] });
      return;
    }

    if (PARALLEL_MARK_RE.test(s)) {
      const stripped = s.replace(PARALLEL_MARK_RE, '').replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
      const parts = stripped.split(/\s*(?:,\s*and\s+|\band\s+(?=(?:the\s+)?[a-z]+(?:\s+[a-z]+)?\s+\w+)|,\s+(?=(?:the\s+)?[a-z]+\s))\s*/i).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        steps.push({ kind: 'par', branches: parts.map((p) => [p]) });
        return;
      }
      s = stripped;
    }

    const el = s.match(ELSE_RE);
    if (el) {
      const rest = s.slice(el[0].length).trim();
      steps.push({ kind: 'else', clauses: rest ? splitClauses(rest) : [] });
      return;
    }

    const c = s.match(COND_RE);
    if (c && !(c[1].toLowerCase() === 'when' && idx === 0)) {
      const keyword = c[1].toLowerCase();
      steps.push({ kind: 'cond', cond: c[2].trim(), invert: keyword === 'unless', clauses: splitClauses(c[3]) });
      return;
    }

    const body = stripLeadIn(s);
    steps.push({ kind: 'task', clauses: splitClauses(body) });
  });

  return { title, trigger, steps };
}

/* ------------------------------------------------------------------ clause parsing */

function baseOf(word: string): string | undefined {
  return VERB_FORMS.get(word.toLowerCase().replace(/[^a-z]/g, ''));
}

function cleanActor(raw: string): string | undefined {
  const t = raw
    .replace(/\b(?:the|a|an|our|their|his|her|its|each|every|all)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.split(' ').length > 5) return undefined;
  if (PRONOUNS.has(t.toLowerCase())) return undefined;
  if (/^system$/i.test(t) || /\bsystem\b/i.test(t) && t.split(' ').length <= 2) return 'System';
  return titleCase(t);
}

function objectPhrase(rest: string): string {
  return rest
    .replace(/^(?:the|a|an|their|his|her|its|all|any)\s+/i, '')
    .split(/[,(]/)[0]
    .replace(/\s+(?:and|so that|in order to|because|which|that|before|after|until|while)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Ctx {
  prevActor?: string;
  lastObject?: string;
}

const PRONOUN_OBJ = /^(?:it|them|this|that|these|those)\b\s*/i;

function resolveObject(obj: string, ctx: Ctx): string {
  if (!PRONOUN_OBJ.test(obj)) return obj;
  const rest = obj.replace(PRONOUN_OBJ, '').replace(/^(?:to|from|with|for)\s+(?:the\s+)?/i, (m) => m.replace(/the\s+/i, ''));
  return [ctx.lastObject, rest].filter(Boolean).join(' ').trim();
}

function mainObject(obj: string): string {
  return obj.split(/\s+(?:with|from|to|against|for|in|on|into|by)\s+/i)[0].trim();
}

function parseClause(text: string, ctx: Ctx): Parsed {
  const prevActor = ctx.prevActor;
  let t = stripLeadIn(text).replace(/^(?:and|but)\s+/i, '').trim();
  if (!t) return { name: '' };

  if (PURE_END_RE.test(t) || PURE_CONT_RE.test(t)) return { name: '', pureEnd: !PURE_CONT_RE.test(t) };

  // Loop back
  const back = t.match(BACK_RE);
  if (back) {
    return { name: '', backTo: back[1].split(/\s+(?:and|so|then|to)\s+/i)[0].trim(), actor: prevActor };
  }

  // Trailing context ("... after the offer is accepted") does not change who does what
  if (t.split(/\s+/).length > 4) t = t.replace(/\s+(?:after|once|before|because|so that|until|as soon as)\s+.+$/i, '');

  const terminal = TERMINAL_VERB_RE.test(t);
  const finish = (actor: string | undefined, verb: string, rawObj: string): Parsed => {
    const obj = resolveObject(rawObj, ctx);
    return {
      actor,
      name: clip(titleCase(verb) + (obj ? ' ' + obj : ''), 64),
      object: mainObject(obj) || ctx.lastObject,
      terminal,
      endLabel: terminal ? endLabelFor(verb, mainObject(obj)) : undefined,
    };
  };

  // Passive voice: "<object> is reviewed by <actor>"
  const passive = t.match(/^(.+?)\s+(?:is|are|was|were|gets?|must be|should be|will be|has to be|needs to be|is then|are then)\s+(\w+)\s+by\s+(?:the\s+)?(.+?)(?:\s+(?:and|then)\b.*)?$/i);
  if (passive && baseOf(passive[2])) {
    return finish(cleanActor(passive[3]), baseOf(passive[2])!, objectPhrase(passive[1]));
  }

  // Passive without agent: "The invoice is archived"
  const passiveNoAgent = t.match(/^(.+?)\s+(?:is|are|was|were|gets?|will be|must be|should be)\s+(?:then\s+)?(\w+)(?:\s+(.*))?$/i);
  if (passiveNoAgent && baseOf(passiveNoAgent[2]) && /(?:ed|en|t)$/i.test(passiveNoAgent[2]) && !/^(?:is|are)\s+/i.test(passiveNoAgent[1])) {
    return finish(prevActor, baseOf(passiveNoAgent[2])!, objectPhrase(passiveNoAgent[1]));
  }

  // Active voice: first verb token that can be a finite verb. After a subject the verb must be inflected
  // ("The new hire completes ...": "hire" is skipped) unless a modal precedes it ("must review").
  const words = t.split(/\s+/);
  let vi = -1;
  let afterModal = false;
  for (let i = 0; i < words.length && i < 9; i++) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (i > 0 && MODALS.has(w)) {
      afterModal = true;
      continue;
    }
    if (/ly$/.test(w) && i > 0 && !VERB_FORMS.has(w)) continue;
    const b = baseOf(w);
    const prev = i > 0 ? words[i - 1].toLowerCase() : '';
    if (b && !/^(?:in|on|at|of|for|by)$/.test(prev) && (i === 0 || b !== w || afterModal)) {
      vi = i;
      break;
    }
  }
  if (vi === -1) {
    // Unknown verb: best effort for "<actor> <verb>s ..." sentences
    const m = t.match(/^((?:the|a|an|our)\s+)?([A-Za-z-]+(?:\s+[A-Za-z-]+)?)\s+(?:(?:must|should|will|can|then)\s+)?([a-z]{3,}s)\s+(.+)$/i);
    if (m) {
      const verb = m[3].replace(/ies$/i, 'y').replace(/(?:sses|ches|shes|xes)$/i, (x) => x.slice(0, -2)).replace(/s$/i, '');
      return finish(cleanActor(m[2]), verb, objectPhrase(m[4]));
    }
    return { name: titleCase(clip(objectPhrase(t), 60)), actor: prevActor, terminal };
  }

  const subject = words
    .slice(0, vi)
    .filter((w) => {
      const l = w.toLowerCase().replace(/[^a-z]/g, '');
      return !(MODALS.has(l) || (/ly$/.test(l) && !VERB_FORMS.has(l)));
    })
    .join(' ');
  const verb = baseOf(words[vi])!;
  const obj = objectPhrase(words.slice(vi + 1).join(' '));

  let actor = subject ? cleanActor(subject) : undefined;
  if (!actor && (!subject || PRONOUNS.has(subject.toLowerCase()))) actor = prevActor;
  return finish(actor, verb, obj);
}

function endLabelFor(verb: string, obj: string): string {
  const past: Record<string, string> = {
    reject: 'rejected', decline: 'declined', deny: 'denied', cancel: 'cancelled', terminate: 'terminated', abort: 'aborted',
  };
  const o = obj.split(' ').slice(0, 3).join(' ');
  return clip(titleCase(o ? `${o} ${past[verb] ?? verb + 'ed'}` : past[verb] ?? 'Ended'), 40);
}

/* ------------------------------------------------------------------ graph builder */

interface Pending {
  id: string;
  label?: string;
}

class Builder {
  nodes: PNode[] = [];
  flows: PFlow[] = [];
  frontier: Pending[] = [];
  lastActor?: string;
  lastObject?: string;
  actors: string[] = [];
  private n = 0;

  /** "Clerk" -> "Finance Clerk" when a longer actor with the same head noun already exists. */
  canon(actor?: string): string | undefined {
    if (!actor) return actor;
    const head = actor.split(' ').pop()!.toLowerCase();
    const known =
      this.actors.find((a) => a.toLowerCase() === actor.toLowerCase()) ??
      this.actors.find((a) => a.split(' ').pop()!.toLowerCase() === head && (a.split(' ').length > 1) !== (actor.split(' ').length > 1));
    if (known) return known.split(' ').length >= actor.split(' ').length ? known : actor;
    return actor;
  }

  id(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  connect(to: string): void {
    for (const p of this.frontier) {
      if (!this.flows.some((f) => f.from === p.id && f.to === to && f.label === p.label)) {
        this.flows.push({ id: `F_${this.flows.length + 1}`, from: p.id, to, label: p.label });
      }
    }
    this.frontier = [{ id: to }];
  }

  add(node: Omit<PNode, 'id'>, connect = true): PNode {
    const full: PNode = { ...node, id: this.id(node.type === 'task' ? 'T' : node.type === 'start' ? 'S' : node.type === 'end' ? 'E' : 'G') };
    this.nodes.push(full);
    if (connect) this.connect(full.id);
    return full;
  }

  findTarget(ref: string): PNode | undefined {
    const tasks = this.nodes.filter((n) => n.type === 'task');
    const actorHit = tasks.find((t) => t.actor && similarity(t.actor, ref) >= 0.5);
    let best: { n: PNode; s: number } | undefined;
    for (const t of tasks) {
      const s = similarity(t.name, ref);
      if (s > 0 && (!best || s > best.s)) best = { n: t, s };
    }
    if (best && best.s >= 0.25) return best.n;
    return actorHit;
  }
}

function kindFor(actor?: string): TaskKind {
  if (!actor) return 'plain';
  return SYSTEM_RE.test(actor) ? 'service' : 'user';
}

/** Emit a chain of clauses. After a loop-back or terminal clause the branch is closed and the rest is ignored. */
function emitClauses(b: Builder, clauses: string[]): void {
  for (const text of clauses) {
    if (!b.frontier.length) return;
    const p = parseClause(text, { prevActor: b.lastActor, lastObject: b.lastObject });
    if (p.pureEnd) {
      b.add({ type: 'end', name: 'Process ended' });
      b.frontier = [];
      return;
    }
    if (p.backTo) {
      const target = b.findTarget(p.backTo);
      if (target) {
        for (const f of b.frontier) {
          b.flows.push({ id: `F_${b.flows.length + 1}`, from: f.id, to: target.id, label: f.label ?? 'Rework' });
        }
        b.frontier = [];
        return;
      }
      const actor = b.canon(p.actor) ?? b.lastActor;
      b.add({ type: 'task', name: clip('Return to ' + p.backTo.replace(/^(?:the)\s+/i, ''), 60), actor, kind: kindFor(actor) });
      b.lastActor = actor;
      continue;
    }
    if (!p.name) continue; // e.g. "the process continues"
    const actor = b.canon(p.actor) ?? b.lastActor;
    if (actor && !b.actors.includes(actor)) b.actors.push(actor);
    b.add({ type: 'task', name: p.name, actor, kind: kindFor(actor) });
    b.lastActor = actor;
    if (p.object) b.lastObject = p.object;
    if (p.terminal) {
      b.add({ type: 'end', name: p.endLabel ?? 'Process ended' });
      b.frontier = [];
    }
  }
}

function questionFor(cond: string): string {
  const q = cond.replace(/^(?:the|a|an)\s+/i, '').replace(/[?.]$/, '').trim();
  return clip(q.charAt(0).toUpperCase() + q.slice(1), 56) + '?';
}

export function extractWithRules(text: string): ProcessModel {
  const { title, trigger, steps } = parseSteps(text);
  const b = new Builder();

  const start = b.add({ type: 'start', name: 'Start' }, false);
  b.frontier = [{ id: start.id }];
  if (trigger) {
    // "When a customer applies for a loan, ..." -> the customer's own first step
    const t = parseClause(trigger, {});
    if (t.actor && t.name) {
      const actor = b.canon(t.actor)!;
      b.actors.push(actor);
      b.add({ type: 'task', name: t.name, actor, kind: kindFor(actor) });
      b.lastActor = actor;
      if (t.object) b.lastObject = t.object;
    } else {
      start.name = clip(trigger, 40);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (step.kind === 'task' || step.kind === 'else') {
      emitClauses(b, step.clauses);
      continue;
    }

    if (step.kind === 'par') {
      if (!b.frontier.length) continue;
      const split = b.add({ type: 'and', name: '' });
      const ends: Pending[] = [];
      const entry = b.frontier;
      const actorBefore = b.lastActor;
      for (const branch of step.branches) {
        b.frontier = [{ id: split.id }];
        b.lastActor = undefined;
        emitClauses(b, branch);
        // A branch whose first clause had no explicit actor inherits the actor before the fork
        ends.push(...b.frontier);
      }
      void entry;
      if (ends.length) {
        b.frontier = ends;
        b.add({ type: 'and', name: '' });
      } else {
        b.frontier = [];
      }
      b.lastActor = actorBefore;
      continue;
    }

    // Decision
    if (!b.frontier.length) {
      emitClauses(b, step.clauses);
      continue;
    }
    const question = questionFor(step.cond);
    const gw = b.add({ type: 'xor', name: question });
    const yesLabel = step.invert ? 'No' : 'Yes';
    const noLabel = step.invert ? 'Yes' : 'No';
    const actorBefore = b.lastActor;

    b.frontier = [{ id: gw.id, label: yesLabel }];
    emitClauses(b, step.clauses);
    const yesEnd = b.frontier;

    let noEnd: Pending[] = [{ id: gw.id, label: noLabel }];
    const next = steps[i + 1];
    if (next && next.kind === 'else') {
      b.frontier = [{ id: gw.id, label: noLabel }];
      b.lastActor = actorBefore;
      emitClauses(b, next.clauses);
      noEnd = b.frontier;
      i++;
    }

    // If a branch did nothing (no tasks created) it stays as the gateway's labelled pending flow.
    b.frontier = [...yesEnd, ...noEnd];
    b.lastActor = actorBefore;
  }

  if (b.frontier.length) {
    const lastTask = [...b.nodes].reverse().find((n) => n.type === 'task');
    b.add({ type: 'end', name: lastTask ? 'Process completed' : 'End', actor: undefined });
  }

  const actors: string[] = [];
  for (const n of b.nodes) if (n.actor && !actors.includes(n.actor)) actors.push(n.actor);

  const resolvedTitle =
    title ||
    (() => {
      const first = b.nodes.find((n) => n.type === 'task');
      return first ? clip(first.name.split(' ').slice(0, 4).join(' ') + ' process', 60) : 'Untitled process';
    })();

  return normalizeModel({ title: resolvedTitle, actors, nodes: b.nodes, flows: b.flows }, resolvedTitle);
}


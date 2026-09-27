// SPDX-License-Identifier: AGPL-3.0-only
// Утопия round structure for Lancer: characters declare their actions and moves in secret, the GM reveals
// every declaration at once, then the round resolves in phases: PC actions, NPC actions, PC moves, NPC moves.
//
// Secrecy: Foundry sends every document to every client, even ones a player has no permission to see, so
// declarations never go into a shared document before the reveal. Players send them to the GM with a user
// query; the GM's client keeps them in a client-scoped setting (browser storage). The combat only carries
// public state: the round, the phase and which combatants have declared.

const MODULE = "utopia";
const PHASES = ["declare", "pcActions", "npcActions", "pcMoves", "npcMoves"];
const PHASE_LABELS = {
  declare: "Declare",
  pcActions: "PC Actions",
  npcActions: "NPC Actions",
  pcMoves: "PC Moves",
  npcMoves: "NPC Moves",
};
const MAX_TEXT = 4000;
const { ApplicationV2, DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const escapeHTML = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const multiline = s => escapeHTML(s).replace(/\n/g, "<br>");
const clip = s => String(s ?? "").slice(0, MAX_TEXT);

function enabled() {
  return game.settings.get(MODULE, "enabled");
}

/** Player characters are combatants whose actor has a player owner. Everything else is on the NPC side. */
function isPC(combatant) {
  return !!combatant.actor?.hasPlayerOwner;
}

/** The public state of a combat. A new round starts back at the declare phase with nothing declared. */
function phaseState(combat) {
  const flag = combat?.getFlag(MODULE, "state") ?? {};
  const fresh = flag.round !== combat?.round;
  return {
    round: combat?.round ?? 0,
    phase: fresh ? "declare" : (flag.phase ?? "declare"),
    declared: fresh ? [] : (flag.declared ?? []),
    revealed: fresh ? false : !!flag.revealed,
  };
}

async function setPhaseState(combat, patch) {
  const state = { ...phaseState(combat), ...patch };
  // Arrays replace wholesale on update, so the declared list can shrink (e.g. when the GM unlocks one)
  await combat.update({ [`flags.${MODULE}.state`]: state });
}

/** Declarations kept in a client-scoped setting: { [combatId]: { round, entries: { [combatantId]: entry } } } */
function loadStore(key) {
  return foundry.utils.deepClone(game.settings.get(MODULE, key) ?? {});
}
function roundEntries(store, combat) {
  let record = store[combat.id];
  if (!record || record.round !== combat.round) record = store[combat.id] = { round: combat.round, entries: {} };
  return record.entries;
}

/** Run GM-side mutations one at a time, so simultaneous declarations don't overwrite each other. */
let gmQueue = Promise.resolve();
function serialized(fn) {
  const run = gmQueue.then(fn, fn);
  gmQueue = run.catch(() => {});
  return run;
}

function rerenderAll() {
  ui.combat?.render();
  for (const app of foundry.applications.instances.values()) {
    if (app instanceof DeclareApp || app instanceof DashboardApp) app.render();
  }
}

/* -------------------------------------------- */
/*  GM side                                     */
/* -------------------------------------------- */

/** Query handler, run on the active GM's client, receiving a player's declaration. */
async function onDeclareQuery(data, { user }) {
  if (!game.user.isGM) throw new Error("Only a GM can receive declarations.");
  return serialized(async () => {
    const combat = game.combats.get(data.combatId);
    if (!combat) throw new Error("That combat no longer exists.");
    if (combat.round !== data.round) throw new Error("The round has changed. Declare for the new round.");
    const state = phaseState(combat);
    if (state.phase !== "declare") throw new Error("Declarations are closed for this round.");
    const combatant = combat.combatants.get(data.combatantId);
    if (!combatant?.actor?.testUserPermission(user, "OWNER")) throw new Error("You don't control that combatant.");

    const store = loadStore("gmStore");
    const entries = roundEntries(store, combat);
    if (entries[combatant.id]) throw new Error("Already declared. You can't change your mind!");
    entries[combatant.id] = { action: clip(data.action), move: clip(data.move), userId: user.id, at: Date.now() };
    await game.settings.set(MODULE, "gmStore", store);
    await setPhaseState(combat, { declared: [...new Set([...state.declared, combatant.id])] });
    rerenderAll();
    return { ok: true };
  });
}

async function saveNpcDeclaration(combat, combatantId, field, value) {
  return serialized(async () => {
    const store = loadStore("gmStore");
    const entries = roundEntries(store, combat);
    const entry = (entries[combatantId] ??= { action: "", move: "", userId: game.user.id, at: Date.now() });
    entry[field] = clip(value);
    await game.settings.set(MODULE, "gmStore", store);
  });
}

async function unlockDeclaration(combat, combatantId) {
  return serialized(async () => {
    const store = loadStore("gmStore");
    delete roundEntries(store, combat)[combatantId];
    await game.settings.set(MODULE, "gmStore", store);
    const state = phaseState(combat);
    await setPhaseState(combat, { declared: state.declared.filter(id => id !== combatantId) });
  });
}

function declarationCard(combat, entries) {
  const section = (title, combatants) => {
    if (!combatants.length) return "";
    const rows = combatants
      .map(c => {
        const e = entries[c.id];
        const body = e
          ? `<div class="utopia-line"><span class="utopia-label">Actions</span>${multiline(e.action) || "<em>none</em>"}</div>
             <div class="utopia-line"><span class="utopia-label">Move</span>${multiline(e.move) || "<em>none</em>"}</div>`
          : `<div class="utopia-line"><em>No declaration</em></div>`;
        return `<div class="utopia-decl"><div class="utopia-name">${escapeHTML(c.name)}</div>${body}</div>`;
      })
      .join("");
    return `<h4>${title}</h4>${rows}`;
  };
  const alive = combat.combatants.filter(c => !c.isDefeated);
  return `<div class="utopia-card">
    <h3>Утопия · Round ${combat.round} declarations</h3>
    ${section("Player characters", alive.filter(isPC))}
    ${section("NPCs", alive.filter(c => !isPC(c)))}
  </div>`;
}

async function reveal(combat) {
  const state = phaseState(combat);
  const pcs = combat.combatants.filter(c => isPC(c) && !c.isDefeated);
  const missing = pcs.filter(c => !state.declared.includes(c.id));
  if (missing.length) {
    const go = await DialogV2.confirm({
      window: { title: "Reveal declarations?" },
      content: `<p>Still waiting on: ${missing.map(c => escapeHTML(c.name)).join(", ")}.</p><p>Reveal anyway?</p>`,
    });
    if (!go) return;
  }
  const entries = roundEntries(loadStore("gmStore"), combat);
  await ChatMessage.create({ content: declarationCard(combat, entries), speaker: { alias: "Утопия" } });
  await setPhaseState(combat, { phase: "pcActions", revealed: true });
}

async function nextPhase(combat) {
  const state = phaseState(combat);
  const index = PHASES.indexOf(state.phase);
  if (index === PHASES.length - 1) {
    // The round is over; a new round starts back at the declare phase
    await combat.nextRound();
  } else {
    await setPhaseState(combat, { phase: PHASES[index + 1] });
  }
}

/* -------------------------------------------- */
/*  Applications                                */
/* -------------------------------------------- */

class UtopiaApp extends ApplicationV2 {
  async _renderHTML() {
    return this.buildHTML();
  }
  _replaceHTML(result, content) {
    content.innerHTML = result;
    this.activate(content);
  }
  buildHTML() {
    return "";
  }
  activate(_html) {}
}

/** Where a player (or the GM) declares for the combatants they control. */
class DeclareApp extends UtopiaApp {
  static DEFAULT_OPTIONS = {
    id: "utopia-declare",
    classes: ["utopia"],
    window: { title: "Утопия: Declare", icon: "fa-solid fa-scroll", resizable: true },
    position: { width: 480, height: "auto" },
  };

  mine(combat) {
    return combat.combatants.filter(c => c.actor?.isOwner && (isPC(c) || !game.user.isGM) && !c.isDefeated);
  }

  buildHTML() {
    const combat = game.combat;
    if (!combat?.started) return `<p class="utopia-empty">No combat is running.</p>`;
    const state = phaseState(combat);
    const mine = this.mine(combat);
    if (!mine.length) return `<p class="utopia-empty">You don't control any combatants in this combat.</p>`;
    const own = roundEntries(loadStore("myStore"), combat);
    const blocks = mine.map(c => {
      const declared = state.declared.includes(c.id);
      const head = `<header class="utopia-name"><img src="${escapeHTML(c.img)}" alt=""> ${escapeHTML(c.name)}</header>`;
      if (declared) {
        const e = own[c.id];
        return `<section class="utopia-block locked">${head}
          <p class="utopia-status"><i class="fa-solid fa-lock"></i> Locked in.</p>
          ${e ? `<div class="utopia-line"><span class="utopia-label">Actions</span>${multiline(e.action)}</div>
                 <div class="utopia-line"><span class="utopia-label">Move</span>${multiline(e.move)}</div>` : ""}
        </section>`;
      }
      if (state.phase !== "declare")
        return `<section class="utopia-block">${head}<p class="utopia-status">Declarations are closed for this round.</p></section>`;
      return `<section class="utopia-block" data-combatant-id="${c.id}">${head}
        <label>Actions<textarea name="action" rows="3" placeholder="What you'll do this round"></textarea></label>
        <label>Move<textarea name="move" rows="2" placeholder="Where you'll move"></textarea></label>
        <button type="button" data-utopia="submit"><i class="fa-solid fa-lock"></i> Lock in</button>
      </section>`;
    });
    return `<p class="utopia-round">Round ${combat.round} · ${PHASE_LABELS[state.phase]}</p>${blocks.join("")}`;
  }

  activate(html) {
    for (const button of html.querySelectorAll('[data-utopia="submit"]')) {
      button.addEventListener("click", ev => this.submit(ev.currentTarget.closest("[data-combatant-id]")));
    }
  }

  async submit(block) {
    const combat = game.combat;
    const combatantId = block.dataset.combatantId;
    const action = block.querySelector('[name="action"]').value;
    const move = block.querySelector('[name="move"]').value;
    const ok = await DialogV2.confirm({
      window: { title: "Lock in your declaration?" },
      content: "<p>You can't change your mind.</p>",
    });
    if (!ok) return;
    const gm = game.users.activeGM;
    if (!gm) return ui.notifications.error("There is no GM connected to receive your declaration.");
    try {
      const data = { combatId: combat.id, round: combat.round, combatantId, action, move };
      if (gm.isSelf) await onDeclareQuery(data, { user: game.user });
      else await gm.query(`${MODULE}.declare`, data, { timeout: 15000 });
    } catch (err) {
      return ui.notifications.error(`Declaration not accepted: ${err.message ?? err}`);
    }
    // Keep our own copy so we can read back what we declared
    const store = loadStore("myStore");
    roundEntries(store, combat)[combatantId] = { action: clip(action), move: clip(move) };
    await game.settings.set(MODULE, "myStore", store);
    ui.notifications.info("Declaration locked in.");
    this.render();
  }
}

/** The GM's view: who has declared, NPC declarations, and the phase controls. */
class DashboardApp extends UtopiaApp {
  static DEFAULT_OPTIONS = {
    id: "utopia-dashboard",
    classes: ["utopia"],
    window: { title: "Утопия: Declarations", icon: "fa-solid fa-chess-board", resizable: true },
    position: { width: 560, height: "auto" },
  };

  buildHTML() {
    const combat = game.combat;
    if (!combat?.started) return `<p class="utopia-empty">Start a combat to use the Утопия round structure.</p>`;
    const state = phaseState(combat);
    const entries = roundEntries(loadStore("gmStore"), combat);
    const alive = combat.combatants.filter(c => !c.isDefeated);
    const pcRows = alive.filter(isPC).map(c => {
      const declared = state.declared.includes(c.id);
      const e = entries[c.id];
      const content =
        state.revealed && e
          ? `<div class="utopia-line"><span class="utopia-label">Actions</span>${multiline(e.action)}</div>
             <div class="utopia-line"><span class="utopia-label">Move</span>${multiline(e.move)}</div>`
          : `<p class="utopia-status">${declared ? '<i class="fa-solid fa-lock"></i> Declared (hidden until reveal)' : '<i class="fa-solid fa-hourglass-half"></i> Waiting…'}</p>`;
      const unlock =
        declared && !state.revealed
          ? `<button type="button" data-utopia="unlock" data-combatant-id="${c.id}" data-tooltip="Let the player declare again"><i class="fa-solid fa-lock-open"></i></button>`
          : "";
      return `<section class="utopia-block"><header class="utopia-name"><img src="${escapeHTML(c.img)}" alt=""> ${escapeHTML(c.name)} ${unlock}</header>${content}</section>`;
    });
    const npcRows = alive
      .filter(c => !isPC(c))
      .map(c => {
        const e = entries[c.id] ?? {};
        const ro = state.phase !== "declare" ? "readonly" : "";
        return `<section class="utopia-block" data-combatant-id="${c.id}"><header class="utopia-name"><img src="${escapeHTML(c.img)}" alt=""> ${escapeHTML(c.name)}</header>
          <label>Actions<textarea name="action" rows="2" ${ro}>${escapeHTML(e.action)}</textarea></label>
          <label>Move<textarea name="move" rows="1" ${ro}>${escapeHTML(e.move)}</textarea></label>
        </section>`;
      });
    const pcCount = alive.filter(isPC).length;
    const controls =
      state.phase === "declare"
        ? `<button type="button" data-utopia="reveal"><i class="fa-solid fa-eye"></i> Reveal (${state.declared.length}/${pcCount} PCs declared)</button>`
        : `<button type="button" data-utopia="next"><i class="fa-solid fa-forward"></i> ${state.phase === "npcMoves" ? "End round" : `Next: ${PHASE_LABELS[PHASES[PHASES.indexOf(state.phase) + 1]]}`}</button>`;
    return `<p class="utopia-round">Round ${combat.round} · ${PHASE_LABELS[state.phase]}</p>
      <h4>Player characters</h4>${pcRows.join("") || '<p class="utopia-empty">None</p>'}
      <h4>NPCs</h4>${npcRows.join("") || '<p class="utopia-empty">None</p>'}
      <footer class="utopia-controls">${controls}</footer>`;
  }

  activate(html) {
    const combat = game.combat;
    if (!combat) return;
    for (const area of html.querySelectorAll("[data-combatant-id] textarea")) {
      area.addEventListener("change", ev => {
        const id = ev.currentTarget.closest("[data-combatant-id]").dataset.combatantId;
        saveNpcDeclaration(combat, id, ev.currentTarget.name, ev.currentTarget.value);
      });
    }
    html.querySelector('[data-utopia="reveal"]')?.addEventListener("click", () => reveal(combat));
    html.querySelector('[data-utopia="next"]')?.addEventListener("click", () => nextPhase(combat));
    for (const b of html.querySelectorAll('[data-utopia="unlock"]')) {
      b.addEventListener("click", ev => unlockDeclaration(combat, ev.currentTarget.dataset.combatantId));
    }
  }
}

/* -------------------------------------------- */
/*  Combat tracker banner                       */
/* -------------------------------------------- */

function renderBanner(app, element) {
  element.querySelector(".utopia-banner")?.remove();
  const combat = game.combat;
  if (!enabled() || !combat?.started) return;
  const state = phaseState(combat);
  const steps = PHASES.map(p => `<li class="${p === state.phase ? "active" : ""}">${PHASE_LABELS[p]}</li>`).join("");
  const pcCount = combat.combatants.filter(c => isPC(c) && !c.isDefeated).length;
  const canDeclare = combat.combatants.some(c => c.actor?.isOwner && isPC(c));
  const buttons = [
    canDeclare || !game.user.isGM
      ? `<button type="button" data-utopia="declare"><i class="fa-solid fa-scroll"></i> Declare</button>`
      : "",
    game.user.isGM
      ? `<button type="button" data-utopia="dashboard"><i class="fa-solid fa-chess-board"></i> Declarations</button>`
      : "",
  ].join("");
  const banner = document.createElement("section");
  banner.className = "utopia-banner";
  banner.innerHTML = `<div class="utopia-title">Утопия · Round ${combat.round}</div>
    <ol class="utopia-steps">${steps}</ol>
    <div class="utopia-progress">${state.phase === "declare" ? `${state.declared.length}/${pcCount} PCs declared` : ""}</div>
    <div class="utopia-buttons">${buttons}</div>`;
  const list = element.querySelector(".combat-tracker");
  if (list) list.before(banner);
  else element.prepend(banner);
  banner.querySelector('[data-utopia="declare"]')?.addEventListener("click", () => new DeclareApp().render(true));
  banner.querySelector('[data-utopia="dashboard"]')?.addEventListener("click", () => new DashboardApp().render(true));
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE, "enabled", {
    name: "Use the Утопия round structure",
    hint: "Show the declare / reveal / phase controls on the combat tracker.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => ui.combat?.render(),
  });
  game.settings.register(MODULE, "autoOpen", {
    name: "Open the Declare window each round",
    hint: "When a new round starts, open the Declare window if you have combatants to declare for.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
  // Client-scoped (browser storage), never shared with other users
  game.settings.register(MODULE, "gmStore", { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE, "myStore", { scope: "client", config: false, type: Object, default: {} });
  CONFIG.queries[`${MODULE}.declare`] = onDeclareQuery;
  game.modules.get(MODULE).api = { DeclareApp, DashboardApp, phaseState, reveal, nextPhase, PHASES };
});

Hooks.on("renderCombatTracker", (app, element) => renderBanner(app, element));

Hooks.on("updateCombat", (combat, changes) => {
  if (!enabled() || combat !== game.combat) return;
  const stateChanged = foundry.utils.hasProperty(changes, `flags.${MODULE}`) || "round" in changes;
  if (!stateChanged) return;
  rerenderAll();
  const state = phaseState(combat);
  if ("round" in changes && combat.started) {
    ui.notifications.info(`Утопия · Round ${combat.round}: declare your actions and moves.`);
    const needsDeclaring = combat.combatants.some(c => c.actor?.isOwner && isPC(c) && !c.isDefeated);
    if (!game.user.isGM && needsDeclaring && game.settings.get(MODULE, "autoOpen")) new DeclareApp().render(true);
  } else if (foundry.utils.hasProperty(changes, `flags.${MODULE}.state.phase`)) {
    ui.notifications.info(`Утопия · ${PHASE_LABELS[state.phase]}`);
  }
});

// Night Ops v1.3 (PAGE-SETUP): sample Checkpoints set-ups for the preview page.
//   screen=checkpoints&host=1          the editor with four checkpoints saved (&cps=0: none yet)
//   screen=lobby&host=1&mode=checkpoints   the lobby in Checkpoints mode (&cps=0 / &cps=1: none / one)
//   screen=lobby&host=0&mode=checkpoints   a player who isn't the host: the count only
// withCpSetup(fixtureResult, params) adds settings.mode and view.cp (the lobby's shape: the list for the host only).
import { cpPlan, checkpointProblem, LIMITS } from '../shared/rules.js';
import { errorText } from '../shared/engine.js';

export const CP_SAMPLES = [
  { id: 'k1', p: [-79.415, 43.6495], r: 35, name: '7-Eleven', task: 'Buy a pack of gum', osm: 'node/1001' },
  { id: 'k2', p: [-79.4115, 43.6462], r: 30, name: 'The big statue', task: 'Selfie with the big statue', osm: null },
  { id: 'k3', p: [-79.417, 43.6455], r: 40, name: 'Bellwoods Coffee', task: 'Photo with something red', osm: 'node/1003' },
  { id: 'k4', p: [-79.4095, 43.644], r: 35, name: 'Gate on Queen St', task: '', osm: null },
];

// The lobby's view.cp as the engine makes it.
export function lobbyCp(view, list) {
  const settings = view.settings || {};
  const n = list.length;
  const plan = cpPlan(settings, n);
  let problem = checkpointProblem(list, view.ring);
  if (!problem && n < LIMITS.checkpointsLeast) problem = errorText('no_checkpoints');
  else if (!problem && plan.slots.length < LIMITS.checkpointsLeast) {
    problem = 'The game is too short for 2 checkpoints. Make it longer or set the open time to Auto.';
  }
  return {
    lobby: true,
    count: n,
    list: view.me && view.me.host ? list.map((c) => ({ ...c, p: c.p.slice() })) : null,
    problem,
    plan: { openMs: plan.openMs, leadMs: plan.leadMs, safeMs: plan.safeMs, fits: plan.slots.length, skipped: plan.skipped },
  };
}

export function withCpSetup(fx, params = {}) {
  const view = fx && fx.view;
  if (!view || view.phase !== 'lobby') return fx;
  const on = params.mode === 'checkpoints' || params.screen === 'checkpoints';
  if (!on) return fx;
  view.settings = { ...view.settings, mode: 'checkpoints' };
  const n = /^\d+$/.test(params.cps || '') ? Math.min(Number(params.cps), CP_SAMPLES.length) : CP_SAMPLES.length;
  view.cp = lobbyCp(view, CP_SAMPLES.slice(0, n));
  return fx;
}

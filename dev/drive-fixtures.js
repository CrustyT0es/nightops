// Night Ops: the dev preview's driver samples (v1.1, PAGE-DRIVER). fixtures.js calls withDriver for
//   ?screen=game&as=driver&state=moving|parked[&pickup=open|coming|none]   the driver (Sam) moving or parked
//   ?screen=game&as=hunter&driver=1[&pickup=open|coming]                    another hunter, Mia driving
//   ?screen=reveal&as=driver   ?screen=lobby&host=1&driver=1[&pick=1]
const NEAR_OFFSET = [-0.0012, 0.0006]; // about 115 m from the car

function rowOf(view, name) {
  return (view.players || []).find((p) => p.name === name) || null;
}

export function withDriver(fx, params = {}) {
  const view = fx.view;
  if (!view) return fx;
  view.settings = { ...view.settings, driver: true };
  if (view.phase === 'lobby') {
    const sam = rowOf(view, 'Sam');
    view.driverPick = params.pick === '1' && sam ? sam.id : null;
    return fx;
  }
  const asDriver = params.as === 'driver';
  const driver = asDriver ? rowOf(view, view.me.name) : rowOf(view, 'Mia');
  if (!driver) return fx;
  driver.driver = true;
  view.me.driver = asDriver;
  for (const m of view.marks) if (m.id === driver.id && m.kind === 'hunter') m.driver = true;
  if (view.phase !== 'live') return fx;
  const pickup = params.pickup === 'none' ? null : params.pickup === 'coming' ? 'coming' : 'open';
  if (asDriver) {
    const parked = params.state === 'parked';
    const mine = view.marks.find((m) => m.id === driver.id && m.kind === 'hunter');
    const mia = rowOf(view, 'Mia');
    const miaMark = view.marks.find((m) => mia && m.id === mia.id && m.kind === 'hunter');
    view.team = null; // the driver has no powers
    if (parked && mine) {
      const ava = rowOf(view, 'Ava');
      const i = view.marks.findIndex((m) => ava && m.id === ava.id && m.kind !== 'sos');
      const near = { id: ava.id, kind: 'near', p: [mine.p[0] + NEAR_OFFSET[0], mine.p[1] + NEAR_OFFSET[1]], r: 0, age: 1000, label: 'Ava' };
      if (i >= 0) view.marks[i] = near;
      else view.marks.push(near);
    }
    view.drive = {
      id: driver.id, name: driver.name, here: true, me: true,
      parked, speedKmh: parked ? 0 : 38, fixAge: 1200,
      pickups: pickup && mia ? [{
        id: 'k1', by: mia.id, name: 'Mia', p: miaMark ? miaMark.p : mine.p, age: 3000, state: pickup, at: view.clock - 20000,
      }] : [],
      near: parked ? 1 : 0, drivenM: 4200, done: 1,
    };
  } else if (view.me.team === 'hunter') {
    view.drive = {
      id: driver.id, name: driver.name, here: true,
      mine: params.pickup === 'open' || params.pickup === 'coming'
        ? { id: 'k1', state: params.pickup, at: view.clock - 20000, comingAt: params.pickup === 'coming' ? view.clock - 5000 : null }
        : null,
    };
  }
  return fx;
}

export const DRIVER_SAMPLES = [
  { screen: 'lobby', host: '1', driver: '1' },
  { screen: 'lobby', host: '0', driver: '1', pick: '1' },
  { screen: 'reveal', as: 'driver' },
  { screen: 'game', as: 'driver', state: 'moving' },
  { screen: 'game', as: 'driver', state: 'parked' },
  { screen: 'game', as: 'hunter', driver: '1' },
  { screen: 'game', as: 'hunter', driver: '1', pickup: 'coming' },
];

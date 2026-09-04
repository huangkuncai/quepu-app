import { MODULE as admin } from './admin/index.js';
import { MODULE as auth } from './auth/index.js';
import { MODULE as club } from './club/index.js';
import { MODULE as floor } from './floor/index.js';
import { MODULE as game } from './game/index.js';
import { MODULE as history } from './history/index.js';
import { MODULE as ledger } from './ledger/index.js';
import { MODULE as lobby } from './lobby/index.js';
import { MODULE as realtime } from './realtime/index.js';
import { MODULE as room } from './room/index.js';
import { MODULE as support } from './support/index.js';

const modules = [auth, lobby, club, floor, room, realtime, game, ledger, history, support, admin];

export const moduleDefinitions = Object.freeze(
  Object.fromEntries(modules.map(module => [module.name, module]))
);

export const moduleNames = Object.freeze(Object.keys(moduleDefinitions));

export function getModule(name) {
  return moduleDefinitions[name];
}

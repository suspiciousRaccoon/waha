// Automatically mark session as ONLINE on any messages activity
import { parseBool } from '@waha/helpers';

export const PRESENCE_AUTO_ONLINE = process.env.WAHA_PRESENCE_AUTO_ONLINE
  ? parseBool(process.env.WAHA_PRESENCE_AUTO_ONLINE)
  : true;

// Duration (in seconds) to keep session ONLINE after activity
// 25 seconds is default web timeout with no activity
export const PRESENCE_AUTO_ONLINE_DURATION_SECONDS =
  parseInt(process.env.WAHA_PRESENCE_AUTO_ONLINE_DURATION_SECONDS) || 25;

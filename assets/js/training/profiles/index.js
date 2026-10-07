import { DATAMOSH_PROFILE } from "./datamosh-profile.js";

const PROFILES = new Map([[DATAMOSH_PROFILE.id, DATAMOSH_PROFILE]]);

export function getTrainingProfile(id) {
  return PROFILES.get(id) || DATAMOSH_PROFILE;
}

export function listTrainingProfiles() {
  return Array.from(PROFILES.values());
}

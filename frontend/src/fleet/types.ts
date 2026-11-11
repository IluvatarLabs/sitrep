// The UI's wire types are the server's own, taken from here as types only: the report contract (protocol.ts) and the activity
// route's reply and entries, declared beside the server's activity store (activity.ts). The contract's few pure helpers are
// imported as values where they are used.
export type * from "../../../server/src/fleet/protocol";
export type * from "../../../server/src/fleet/activity";

/** The product's name, kept in one place. */
export const APP_NAME = "SITREP";
/** What it is, in two words: the line under the name. */
export const APP_KIND = "Agent Dashboard";

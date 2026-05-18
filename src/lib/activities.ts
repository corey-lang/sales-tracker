export const ACTIVITIES = [
  { key: "office_visits", label: "Office visits" },
  { key: "service_requests", label: "Service requests" },
  { key: "ones_scheduled", label: "1-on-1s scheduled" },
  { key: "ones_held", label: "1-on-1s held" },
  { key: "presentations", label: "Presentations" },
  { key: "impressions", label: "Impressions" },
  { key: "team_meetings", label: "Team meetings" },
  { key: "gold_list_touches", label: "Gold List Contact" },
] as const;

export type ActivityKey = (typeof ACTIVITIES)[number]["key"];

export type ActivityValues = Record<ActivityKey, number>;

export const ZERO_ACTIVITY: ActivityValues = {
  office_visits: 0,
  service_requests: 0,
  ones_scheduled: 0,
  ones_held: 0,
  presentations: 0,
  impressions: 0,
  team_meetings: 0,
  gold_list_touches: 0,
};

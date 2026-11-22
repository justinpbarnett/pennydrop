import type { Step } from "../format";
import type { RuleReview } from "../source";

export interface CourseRule {
  rule_id: number;
  rule: string;
  condition: string;
  held: boolean;
}

export interface CourseLink {
  lesson_id: string;
  title: string;
  rules: [number, number];
}

export interface CourseTopic {
  id: number;
  code: string;
  title: string;
  part: number;
  subtopics: string[];
  lesson_id: string | null;
  lesson_status: string | null;
  rules: CourseRule[];
}

export interface Course {
  id: number;
  slug: string;
  title: string;
  summary: string;
  honor_code: string;
  topics: CourseTopic[];
  rules_held: number;
  rules_total: number;
  links: CourseLink[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

const forProfile = (profile: number | null) => (profile === null ? "" : `?profile_id=${profile}`);

export const fetchCourses = (profile: number | null) => getJson<Course[]>(`/api/courses${forProfile(profile)}`);
export const fetchCourse = (reference: string, profile: number | null) => getJson<Course>(`/api/courses/${encodeURIComponent(reference)}${forProfile(profile)}`);
export const fetchDue = (profile: number) => getJson<RuleReview[]>(`/api/review?profile_id=${profile}`);
export const fetchQueue = (profile: number) => getJson<RuleReview[]>(`/api/review/queue?profile_id=${profile}`);

export async function fetchCase(rule: number, profile: number): Promise<Step> {
  const response = await fetch(`/api/review/${rule}/case`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile_id: profile }) });
  if (!response.ok) throw new Error(`a new case could not be written: the server answered ${response.status}`);
  return (await response.json()) as Step;
}

export function comesBack(iso: string, now = new Date()): string {
  const due = new Date(iso);
  const minutes = Math.round((due.getTime() - now.getTime()) / 60000);
  const absolute = due.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (minutes <= 0) return `due now (${absolute})`;
  if (minutes < 60) return `in ${minutes} min (${absolute})`;
  if (minutes < 60 * 36) return `in ${Math.round(minutes / 60)} h (${absolute})`;
  return `in ${Math.round(minutes / 1440)} days (${absolute})`;
}

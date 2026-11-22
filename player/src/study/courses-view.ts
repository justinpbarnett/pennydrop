import { h } from "../dom";
import { type Course, type CourseRule, type CourseTopic, fetchCourse, fetchCourses } from "./api";

const STATUS_LABELS: Record<string, string> = { ready: "Ready", writing: "Writing", failed: "Failed" };

const heldCount = (course: Pick<Course, "rules_held" | "rules_total">) => `${course.rules_held} of ${course.rules_total} Rules held`;

function badge(topic: CourseTopic): HTMLElement {
  const status = topic.lesson_status ?? "none";
  return h("span", { class: `badge ${status}` }, STATUS_LABELS[status] ?? "Not written yet");
}

function ruleItem(rule: CourseRule): HTMLElement {
  return h("li", { class: rule.held ? "course-rule held" : "course-rule" },
    h("span", { class: "rule-mark", "aria-hidden": "true" }),
    h("span", { class: "rule-name" }, rule.rule),
    h("span", { class: rule.held ? "badge ready" : "badge" }, rule.held ? "Held" : "Not held yet"));
}

function topicRow(topic: CourseTopic): HTMLElement {
  const open = topic.lesson_id && topic.lesson_status === "ready"
    ? h("a", { class: "open", href: `/?lesson=${encodeURIComponent(topic.lesson_id)}` }, "Open Lesson")
    : h("span", { class: "open off" }, "No Lesson yet");
  return h("li", { class: "topic" },
    h("span", { class: "code" }, topic.code),
    h("div", { class: "topic-text" }, h("p", { class: "topic-title" }, topic.title), topic.subtopics.length ? h("p", { class: "topic-sub" }, `${topic.subtopics.length} subtopics`) : null),
    badge(topic),
    open,
    topic.rules.length ? h("ul", { class: "course-rules", "aria-label": `Rules in ${topic.title}` }, ...topic.rules.map(ruleItem)) : null);
}

function linkSection(course: Course): HTMLElement | null {
  if (course.links.length === 0) return null;
  const rules = new Map(course.topics.flatMap((topic) => topic.rules).map((rule) => [rule.rule_id, rule.rule]));
  return h("section", {}, h("h2", {}, "Link Lessons"),
    h("ul", { class: "links" }, ...course.links.map((link) => h("li", { class: "link-lesson" },
      h("a", { class: "link-title", href: `/?lesson=${encodeURIComponent(link.lesson_id)}` }, link.title),
      h("p", { class: "link-rules" }, link.rules.map((id) => rules.get(id) ?? "a removed Rule").join("  +  "))))));
}

export async function courseList(profile: number | null): Promise<HTMLElement> {
  const courses = await fetchCourses(profile);
  if (courses.length === 0) return h("p", { class: "none" }, "No Courses yet. Load one with `pd course seed <file>`.");
  return h("div", { class: "course-grid" }, ...courses.map((course) => h("a", { class: "course-card", href: `?course=${encodeURIComponent(course.slug)}` },
    h("p", { class: "kicker" }, course.slug.toUpperCase()),
    h("p", { class: "course-title" }, course.title),
    h("p", { class: "course-summary" }, course.summary),
    h("p", { class: "course-count" }, heldCount(course)))));
}

export async function courseDetail(reference: string, profile: number | null): Promise<HTMLElement> {
  const course = await fetchCourse(reference, profile);
  const parts = new Map<number, CourseTopic[]>();
  course.topics.forEach((topic) => parts.set(topic.part, [...(parts.get(topic.part) ?? []), topic]));
  return h("div", { class: "course" },
    h("a", { class: "back", href: "?view=courses" }, "All Courses"),
    h("h1", {}, course.title),
    h("p", { class: "lede" }, course.summary),
    h("p", { class: "progress", role: "status" }, heldCount(course)),
    h("p", { class: "honor" }, h("strong", {}, "Honor code. "), course.honor_code),
    ...Array.from(parts, ([part, topics]) => h("section", {}, h("h2", {}, `Part ${part}`), h("ul", { class: "topics" }, ...topics.map(topicRow)))),
    linkSection(course));
}

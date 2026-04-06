export type Status = "in_progress" | "todo" | "backlog" | "done" | "cancelled";
export type Priority = "urgent" | "high" | "medium" | "low";
export type Role = "admin" | "member" | "viewer";

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatar?: string;
}

export interface Comment {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  labels: string[];
  assigneeId: string | null;
  createdById: string;
  comments: Comment[];
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  memberIds: string[];
}

export interface Project {
  id: string;
  name: string;
  teamId: string;
}

// ── Members ──

export const members: Member[] = [
  { id: "m1", name: "Ava Chen", email: "ava@example.com", role: "admin" },
  {
    id: "m2",
    name: "Marcus Webb",
    email: "marcus@example.com",
    role: "member",
  },
  {
    id: "m3",
    name: "Priya Sharma",
    email: "priya@example.com",
    role: "member",
  },
  { id: "m4", name: "Jordan Lee", email: "jordan@example.com", role: "viewer" },
];

// ── Teams ──

export const teams: Team[] = [
  { id: "t1", name: "Engineering", memberIds: ["m1", "m2", "m3"] },
  { id: "t2", name: "Design", memberIds: ["m3", "m4"] },
];

// ── Projects ──

export const projects: Project[] = [
  { id: "p1", name: "Mobile App", teamId: "t1" },
  { id: "p2", name: "Dashboard", teamId: "t1" },
];

// ── Issues ──

export const issues: Issue[] = [
  {
    id: "i1",
    identifier: "MOB-1",
    title: "Implement pull-to-refresh on feed",
    description:
      "Add native pull-to-refresh gesture to the main feed screen. Should trigger a data refetch and show the native refresh indicator.",
    status: "in_progress",
    priority: "high",
    labels: ["feature", "ux"],
    assigneeId: "m2",
    createdById: "m1",
    comments: [
      {
        id: "c1",
        authorId: "m1",
        body: "Let's use the native RefreshControl for this.",
        createdAt: "2026-04-01T10:00:00Z",
      },
      {
        id: "c2",
        authorId: "m2",
        body: "Started on this, should have a PR by EOD.",
        createdAt: "2026-04-02T14:30:00Z",
      },
    ],
    createdAt: "2026-03-28T09:00:00Z",
  },
  {
    id: "i2",
    identifier: "MOB-2",
    title: "Fix keyboard overlap on comment input",
    description:
      "On smaller devices the keyboard covers the comment text input. Need to add KeyboardAvoidingView or similar solution.",
    status: "in_progress",
    priority: "urgent",
    labels: ["bug"],
    assigneeId: "m3",
    createdById: "m2",
    comments: [],
    createdAt: "2026-04-01T11:00:00Z",
  },
  {
    id: "i3",
    identifier: "MOB-3",
    title: "Add dark mode support",
    description:
      "Implement system-aware dark mode using the existing color tokens. All screens should respect the user's system preference.",
    status: "todo",
    priority: "medium",
    labels: ["feature", "design"],
    assigneeId: null,
    createdById: "m1",
    comments: [
      {
        id: "c3",
        authorId: "m4",
        body: "I can provide the dark palette this week.",
        createdAt: "2026-04-03T09:00:00Z",
      },
    ],
    createdAt: "2026-03-30T15:00:00Z",
  },
  {
    id: "i4",
    identifier: "MOB-4",
    title: "Optimize image loading in list views",
    description:
      "Images in the feed are loading synchronously causing jank. Switch to progressive loading with blur placeholders.",
    status: "todo",
    priority: "high",
    labels: ["performance"],
    assigneeId: "m2",
    createdById: "m3",
    comments: [],
    createdAt: "2026-04-01T08:00:00Z",
  },
  {
    id: "i5",
    identifier: "MOB-5",
    title: "Set up push notification handling",
    description:
      "Register for push tokens, handle incoming notifications in foreground/background, and deep-link to the relevant screen.",
    status: "todo",
    priority: "medium",
    labels: ["feature"],
    assigneeId: null,
    createdById: "m1",
    comments: [],
    createdAt: "2026-04-02T10:00:00Z",
  },
  {
    id: "i6",
    identifier: "MOB-6",
    title: "Research offline storage strategy",
    description:
      "Evaluate SQLite vs MMKV vs AsyncStorage for local caching. Write a short RFC with pros/cons for each approach.",
    status: "backlog",
    priority: "low",
    labels: ["research"],
    assigneeId: null,
    createdById: "m1",
    comments: [],
    createdAt: "2026-03-25T12:00:00Z",
  },
  {
    id: "i7",
    identifier: "MOB-7",
    title: "Add haptic feedback to interactions",
    description:
      "Add subtle haptic feedback on button presses, tab switches, and pull-to-refresh completion.",
    status: "backlog",
    priority: "low",
    labels: ["ux"],
    assigneeId: null,
    createdById: "m4",
    comments: [],
    createdAt: "2026-03-26T14:00:00Z",
  },
  {
    id: "i8",
    identifier: "MOB-8",
    title: "Migrate to Expo Router v3",
    description:
      "Update routing from v2 to v3. Handle breaking changes in layout routes and typed routes.",
    status: "backlog",
    priority: "medium",
    labels: ["tech-debt"],
    assigneeId: null,
    createdById: "m2",
    comments: [],
    createdAt: "2026-03-27T16:00:00Z",
  },
  {
    id: "i9",
    identifier: "MOB-9",
    title: "Onboarding flow complete",
    description:
      "Built the 3-screen onboarding carousel with skip and continue buttons. Works on all device sizes.",
    status: "done",
    priority: "high",
    labels: ["feature", "ux"],
    assigneeId: "m3",
    createdById: "m1",
    comments: [
      {
        id: "c4",
        authorId: "m1",
        body: "Looks great, merging!",
        createdAt: "2026-03-29T17:00:00Z",
      },
    ],
    createdAt: "2026-03-20T09:00:00Z",
  },
  {
    id: "i10",
    identifier: "MOB-10",
    title: "Fix splash screen flash on Android",
    description:
      "There was a white flash between the splash screen and the app load on Android. Fixed by keeping the splash visible until assets load.",
    status: "done",
    priority: "medium",
    labels: ["bug"],
    assigneeId: "m2",
    createdById: "m2",
    comments: [],
    createdAt: "2026-03-22T11:00:00Z",
  },
  {
    id: "i11",
    identifier: "MOB-11",
    title: "Remove legacy auth screen",
    description:
      "The old password-based auth screen was replaced by SSO. Removed the dead code and related tests.",
    status: "cancelled",
    priority: "low",
    labels: ["tech-debt"],
    assigneeId: "m1",
    createdById: "m1",
    comments: [],
    createdAt: "2026-03-15T10:00:00Z",
  },
];

// ── Helpers ──

export const STATUS_ORDER: Status[] = [
  "in_progress",
  "todo",
  "backlog",
  "done",
  "cancelled",
];

export const STATUS_LABELS: Record<Status, string> = {
  in_progress: "In Progress",
  todo: "Todo",
  backlog: "Backlog",
  done: "Done",
  cancelled: "Cancelled",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function getMember(id: string | null): Member | undefined {
  return members.find((m) => m.id === id);
}

export function getIssuesByStatus(): { title: string; data: Issue[] }[] {
  return STATUS_ORDER.map((status) => ({
    title: STATUS_LABELS[status],
    data: issues.filter((i) => i.status === status),
  })).filter((section) => section.data.length > 0);
}

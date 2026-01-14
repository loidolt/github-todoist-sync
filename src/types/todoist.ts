/**
 * Todoist project from the API
 */
export interface TodoistProject {
  id: string;
  name: string;
  parent_id: string | null;
  color?: string;
  is_archived?: boolean;
  is_favorite?: boolean;
  view_style?: string;
}

/**
 * Todoist section from the API
 */
export interface TodoistSection {
  id: string;
  project_id: string;
  name: string;
  section_order?: number;
}

/**
 * Todoist task from the API (REST API format)
 */
export interface TodoistTask {
  id: string;
  project_id: string;
  content: string;
  description: string;
  section_id?: string | null;
  is_completed?: boolean;
  priority?: number;
  due?: {
    date: string;
    string?: string;
    datetime?: string;
    timezone?: string;
  } | null;

  /** Enriched during polling - GitHub org */
  _githubOrg?: string;

  /** Enriched during polling - repo name */
  _repoName?: string;

  /** Enriched during polling - full repo name */
  _fullRepo?: string;
}

/**
 * Todoist task from the Sync API format
 */
export interface TodoistSyncTask {
  id: string;
  project_id: string;
  content: string;
  description: string;
  section_id?: string | null;
  checked?: number;
  priority?: number;
  due?: {
    date: string;
    string?: string;
    datetime?: string;
    timezone?: string;
  } | null;

  /** Enriched during polling - GitHub org */
  _githubOrg?: string;

  /** Enriched during polling - repo name */
  _repoName?: string;

  /** Enriched during polling - full repo name */
  _fullRepo?: string;
}

/**
 * Todoist completed task from /completed/get_all endpoint
 */
export interface TodoistCompletedTask {
  id: string;
  task_id: string;
  content: string;
  project_id: string;
  completed_at: string;
}

/**
 * Parent project with GitHub org mapping
 */
export interface ParentProject {
  id: string;
  name: string;
  githubOrg: string;
}

/**
 * Sub-project representing a GitHub repo
 */
export interface SubProject {
  id: string;
  name: string;
  parentId: string;
  githubOrg: string;
  repoName: string;
  fullRepo: string;
}

/**
 * Project hierarchy for org/repo mapping
 */
export interface ProjectHierarchy {
  /** Parent projects mapped by ID */
  parentProjects: Map<string, ParentProject>;

  /** Sub-projects mapped by ID */
  subProjects: Map<string, SubProject>;

  /** Quick lookup: "owner/repo" -> project ID */
  repoToProject: Map<string, string>;
}

/**
 * Section cache: project ID -> section name -> section ID
 */
export type SectionCache = Map<string, Map<string, string>>;

/**
 * Sync API response
 */
export interface TodoistSyncResponse {
  sync_token: string;
  full_sync: boolean;
  items?: TodoistSyncTask[];
  projects?: TodoistProject[];
  sections?: TodoistSection[];
  sync_status?: Record<string, string>;
  temp_id_mapping?: Record<string, string>;
}

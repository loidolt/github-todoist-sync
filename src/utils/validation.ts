/**
 * Runtime validation utilities for API responses
 *
 * These validators check that API responses have the expected shape at runtime,
 * providing early error detection for unexpected API changes or malformed data.
 */

/**
 * Validation error thrown when an API response doesn't match expected shape
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly expected: string,
    public readonly received: unknown
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Check if a value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if a value is an array
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Check if a value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Check if a value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/**
 * Check if a value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Validate that a value is an array
 * @throws ValidationError if not an array
 */
export function validateArray(value: unknown, field: string): unknown[] {
  if (!isArray(value)) {
    throw new ValidationError(
      `Expected ${field} to be an array`,
      field,
      'array',
      typeof value
    );
  }
  return value;
}

/**
 * Validate that a value is an object
 * @throws ValidationError if not an object
 */
export function validateObject(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ValidationError(
      `Expected ${field} to be an object`,
      field,
      'object',
      typeof value
    );
  }
  return value;
}

/**
 * Validate that a value is a string
 * @throws ValidationError if not a string
 */
export function validateString(value: unknown, field: string): string {
  if (!isString(value)) {
    throw new ValidationError(
      `Expected ${field} to be a string`,
      field,
      'string',
      typeof value
    );
  }
  return value;
}

/**
 * Validate that a value is a number
 * @throws ValidationError if not a number
 */
export function validateNumber(value: unknown, field: string): number {
  if (!isNumber(value)) {
    throw new ValidationError(
      `Expected ${field} to be a number`,
      field,
      'number',
      typeof value
    );
  }
  return value;
}

/**
 * Validate a Todoist project response
 */
export interface ValidatedTodoistProject {
  id: string;
  name: string;
  parent_id: string | null;
}

export function validateTodoistProject(value: unknown, index?: number): ValidatedTodoistProject {
  const prefix = index !== undefined ? `projects[${index}]` : 'project';
  const obj = validateObject(value, prefix);

  // id can be string or number in the API
  const id = obj.id;
  if (!isString(id) && !isNumber(id)) {
    throw new ValidationError(`Expected ${prefix}.id to be string or number`, `${prefix}.id`, 'string | number', typeof id);
  }

  const name = obj.name;
  if (!isString(name)) {
    throw new ValidationError(`Expected ${prefix}.name to be string`, `${prefix}.name`, 'string', typeof name);
  }

  const parentId = obj.parent_id;
  if (parentId !== null && !isString(parentId) && !isNumber(parentId)) {
    throw new ValidationError(`Expected ${prefix}.parent_id to be string, number, or null`, `${prefix}.parent_id`, 'string | number | null', typeof parentId);
  }

  return {
    id: String(id),
    name,
    parent_id: parentId === null ? null : String(parentId),
  };
}

/**
 * Validate an array of Todoist projects
 */
export function validateTodoistProjects(value: unknown): ValidatedTodoistProject[] {
  const arr = validateArray(value, 'projects');
  return arr.map((item, index) => validateTodoistProject(item, index));
}

/**
 * Validate a Todoist section response
 */
export interface ValidatedTodoistSection {
  id: string;
  project_id: string;
  name: string;
}

export function validateTodoistSection(value: unknown, index?: number): ValidatedTodoistSection {
  const prefix = index !== undefined ? `sections[${index}]` : 'section';
  const obj = validateObject(value, prefix);

  const id = obj.id;
  if (!isString(id) && !isNumber(id)) {
    throw new ValidationError(`Expected ${prefix}.id to be string or number`, `${prefix}.id`, 'string | number', typeof id);
  }

  const projectId = obj.project_id;
  if (!isString(projectId) && !isNumber(projectId)) {
    throw new ValidationError(`Expected ${prefix}.project_id to be string or number`, `${prefix}.project_id`, 'string | number', typeof projectId);
  }

  const name = obj.name;
  if (!isString(name)) {
    throw new ValidationError(`Expected ${prefix}.name to be string`, `${prefix}.name`, 'string', typeof name);
  }

  return {
    id: String(id),
    project_id: String(projectId),
    name,
  };
}

/**
 * Validate an array of Todoist sections
 */
export function validateTodoistSections(value: unknown): ValidatedTodoistSection[] {
  const arr = validateArray(value, 'sections');
  return arr.map((item, index) => validateTodoistSection(item, index));
}

/**
 * Validate a Todoist task (Sync API format)
 */
export interface ValidatedTodoistSyncTask {
  id: string;
  project_id: string;
  content: string;
  description: string;
  section_id: string | null;
  checked: number;
}

export function validateTodoistSyncTask(value: unknown, index?: number): ValidatedTodoistSyncTask {
  const prefix = index !== undefined ? `items[${index}]` : 'item';
  const obj = validateObject(value, prefix);

  const id = obj.id;
  if (!isString(id) && !isNumber(id)) {
    throw new ValidationError(`Expected ${prefix}.id to be string or number`, `${prefix}.id`, 'string | number', typeof id);
  }

  const projectId = obj.project_id;
  if (!isString(projectId) && !isNumber(projectId)) {
    throw new ValidationError(`Expected ${prefix}.project_id to be string or number`, `${prefix}.project_id`, 'string | number', typeof projectId);
  }

  const content = obj.content;
  if (!isString(content)) {
    throw new ValidationError(`Expected ${prefix}.content to be string`, `${prefix}.content`, 'string', typeof content);
  }

  // description might be missing or null
  const description = obj.description;
  const validDescription = isString(description) ? description : '';

  // section_id can be null, string, or number
  const sectionId = obj.section_id;
  const validSectionId = sectionId === null || sectionId === undefined
    ? null
    : String(sectionId);

  // checked is 0 or 1 in Sync API
  const checked = obj.checked;
  const validChecked = isNumber(checked) ? checked : 0;

  return {
    id: String(id),
    project_id: String(projectId),
    content,
    description: validDescription,
    section_id: validSectionId,
    checked: validChecked,
  };
}

/**
 * Validate an array of Todoist sync tasks
 */
export function validateTodoistSyncTasks(value: unknown): ValidatedTodoistSyncTask[] {
  const arr = validateArray(value, 'items');
  return arr.map((item, index) => validateTodoistSyncTask(item, index));
}

/**
 * Validate a GitHub issue response
 */
export interface ValidatedGitHubIssue {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  milestone: { title: string; number: number } | null;
}

export function validateGitHubIssue(value: unknown, index?: number): ValidatedGitHubIssue {
  const prefix = index !== undefined ? `issues[${index}]` : 'issue';
  const obj = validateObject(value, prefix);

  const number = obj.number;
  if (!isNumber(number)) {
    throw new ValidationError(`Expected ${prefix}.number to be number`, `${prefix}.number`, 'number', typeof number);
  }

  const title = obj.title;
  if (!isString(title)) {
    throw new ValidationError(`Expected ${prefix}.title to be string`, `${prefix}.title`, 'string', typeof title);
  }

  const htmlUrl = obj.html_url;
  if (!isString(htmlUrl)) {
    throw new ValidationError(`Expected ${prefix}.html_url to be string`, `${prefix}.html_url`, 'string', typeof htmlUrl);
  }

  const state = obj.state;
  if (state !== 'open' && state !== 'closed') {
    throw new ValidationError(`Expected ${prefix}.state to be 'open' or 'closed'`, `${prefix}.state`, "'open' | 'closed'", state);
  }

  // milestone can be null or an object
  let validMilestone: { title: string; number: number } | null = null;
  if (obj.milestone !== null && obj.milestone !== undefined) {
    const milestone = validateObject(obj.milestone, `${prefix}.milestone`);
    const milestoneTitle = milestone.title;
    const milestoneNumber = milestone.number;

    if (!isString(milestoneTitle)) {
      throw new ValidationError(`Expected ${prefix}.milestone.title to be string`, `${prefix}.milestone.title`, 'string', typeof milestoneTitle);
    }
    if (!isNumber(milestoneNumber)) {
      throw new ValidationError(`Expected ${prefix}.milestone.number to be number`, `${prefix}.milestone.number`, 'number', typeof milestoneNumber);
    }

    validMilestone = { title: milestoneTitle, number: milestoneNumber };
  }

  return {
    number,
    title,
    html_url: htmlUrl,
    state,
    milestone: validMilestone,
  };
}

/**
 * Validate an array of GitHub issues
 */
export function validateGitHubIssues(value: unknown): ValidatedGitHubIssue[] {
  const arr = validateArray(value, 'issues');
  return arr.map((item, index) => validateGitHubIssue(item, index));
}

/**
 * Safely validate with a fallback - logs warning but doesn't throw
 * Useful for non-critical validation where we want to continue on failure
 */
export function safeValidate<T>(
  validator: () => T,
  fallback: T,
  context: string
): T {
  try {
    return validator();
  } catch (error) {
    if (error instanceof ValidationError) {
      console.warn(
        `Validation warning in ${context}: ${error.message} (field: ${error.field}, expected: ${error.expected}, received: ${JSON.stringify(error.received)})`
      );
    } else {
      console.warn(`Validation warning in ${context}:`, error);
    }
    return fallback;
  }
}

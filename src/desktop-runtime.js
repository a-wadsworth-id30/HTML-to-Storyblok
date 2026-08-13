import path from 'node:path';

export const DEFAULT_DESKTOP_WORKSPACE_NAME = 'default';
export const DEFAULT_DESKTOP_WORK_DIR_NAME = 'html-to-storyblok';

export function createDesktopRuntime({
  appRoot = process.cwd(),
  userDataPath = null,
  workspaceName = DEFAULT_DESKTOP_WORKSPACE_NAME,
  workDirName = DEFAULT_DESKTOP_WORK_DIR_NAME
} = {}) {
  const resolvedAppRoot = path.resolve(appRoot);
  const resolvedUserDataPath = path.resolve(userDataPath || path.join(resolvedAppRoot, '.tmp', 'desktop-user-data'));
  const safeWorkspaceName = safePathSegment(workspaceName, DEFAULT_DESKTOP_WORKSPACE_NAME);
  const safeWorkDirName = safePathSegment(workDirName, DEFAULT_DESKTOP_WORK_DIR_NAME);
  const workspaceRoot = path.join(resolvedUserDataPath, 'workspaces', safeWorkspaceName);
  const defaultWorkDir = path.join(workspaceRoot, safeWorkDirName);
  const defaultManifestPath = path.join(defaultWorkDir, 'integration-manifest.json');

  return {
    app_root: resolvedAppRoot,
    user_data_path: resolvedUserDataPath,
    workspace_name: safeWorkspaceName,
    workspace_root: workspaceRoot,
    default_work_dir: defaultWorkDir,
    default_manifest_path: defaultManifestPath,
    default_template_path: path.join(resolvedAppRoot, 'templates', 'acme-campaign')
  };
}

export function createDesktopCliSpawnConfig({
  electronExecPath,
  binPath,
  builtCommand,
  runtime,
  sessionEnv = {},
  baseEnv = process.env
}) {
  return {
    command: electronExecPath,
    args: [binPath, ...builtCommand.args],
    options: {
      cwd: builtCommand.cwd || runtime.app_root,
      env: {
        ...baseEnv,
        ...sessionEnv,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  };
}

export function isInsideDesktopRuntimePath(filePath, runtime) {
  const absolute = path.resolve(filePath);
  return isInsideOrSame(runtime.app_root, absolute) || isInsideOrSame(runtime.user_data_path, absolute);
}

export function isInsideRendererAppPath(filePath, runtime) {
  return isInsideOrSame(runtime.app_root, path.resolve(filePath));
}

function isInsideOrSame(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safePathSegment(value, fallback) {
  const segment = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(segment)) return fallback;
  return segment;
}

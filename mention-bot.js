/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 */

'use strict';

var githubAuthCookies = require('./githubAuthCookies');
var config = require('./config');
var fs = require('fs');
var minimatch = require('minimatch');

async function downloadFileAsync(url: string, cookies: ?string): Promise<string> {
  return new Promise(function(resolve, reject) {
    var args = ['--silent', '-L', url];

    if (cookies) {
      args.push('-H', `Cookie: ${cookies}`);
    }

    require('child_process')
      .execFile('curl', args, {encoding: 'utf8', maxBuffer: 1000 * 1024 * 10}, function(error, stdout, stderr) {
        if (error) {
          reject(error);
        } else {
          resolve(stdout.toString());
        }
      });
  });
}

async function readFileAsync(name: string, encoding: string): Promise<string> {
  return new Promise(function(resolve, reject) {
    fs.readFile(name, encoding, function(err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

type FileInfo = {
  path: string,
  deletedLines: Array<number>,
};

type WhitelistUser = {
  name: string,
  files: Array<string>,
  skipTeamPrs: bool
};

type TeamData = {
  name: string,
  id: number
};

type TeamMembership = {
  name: string,
  state: string
};

function startsWith(str, start) {
  return str.substr(0, start.length) === start;
}

function parseDiffFile(lines: Array<string>): FileInfo {
  var deletedLines = [];

  // diff --git a/path b/path
  var line = lines.pop();
  if (!line.match(/^diff --git a\//)) {
    throw new Error('Invalid line, should start with `diff --git a/`, instead got \n' + line + '\n');
  }
  var fromFile = line.replace(/^diff --git a\/(.+) b\/.+/g, '$1');

  // index sha..sha mode
  line = lines.pop();
  if (startsWith(line, 'deleted file') ||
      startsWith(line, 'new file')) {
    line = lines.pop();
  }

  line = lines.pop();
  if (!line) {
    // If the diff ends in an empty file with 0 additions or deletions, line will be null
  } else if (startsWith(line, 'diff --git')) {
    lines.push(line);
  } else if (startsWith(line, 'Binary files')) {
    // We just ignore binary files (mostly images). If we want to improve the
    // precision in the future, we could look at the history of those files
    // to get more names.
  } else if (startsWith(line, '--- ')) {
    // +++ path
    line = lines.pop();
    if (!line.match(/^\+\+\+ /)) {
      throw new Error('Invalid line, should start with `+++`, instead got \n' + line + '\n');
    }

    var currentFromLine = 0;
    while (lines.length > 0) {
      line = lines.pop();
      if (startsWith(line, 'diff --git')) {
        lines.push(line);
        break;
      }

      // @@ -from_line,from_count +to_line,to_count @@ first line
      if (startsWith(line, '@@')) {
        var matches = line.match(/^\@\@ -([0-9]+),?([0-9]+)? \+([0-9]+),?([0-9]+)? \@\@/);
        if (!matches) {
          continue;
        }

        var from_line = matches[1];
        var from_count = matches[2];
        var to_line = matches[3];
        var to_count = matches[4];

        currentFromLine = +from_line;
        continue;
      }

      if (startsWith(line, '-')) {
        deletedLines.push(currentFromLine);
      }
      if (!startsWith(line, '+')) {
        currentFromLine++;
      }
    }
  }

  return {
    path: fromFile,
    deletedLines: deletedLines,
  };
}

function parseDiff(diff: string): Array<FileInfo> {
  var files = [];
  // The algorithm is designed to be best effort. If the http request failed
  // for some reason and we get an empty file, we should not crash.
  if (!diff || !diff.match(/^diff/)) {
    return files;
  }

  var lines = diff.trim().split('\n');
  // Hack Array doesn't have shift/unshift to work from the beginning of the
  // array, so we reverse the entire array in order to be able to use pop/add.
  lines.reverse();

  while (lines.length > 0) {
    files.push(parseDiffFile(lines));
  }

  return files;
}

async function getDiffForPullRequest(
  owner: string,
  repo: string,
  id: number,
  github: Object
): Promise<string> {
  return new Promise(function(resolve, reject) {
    github.pullRequests.get({
      user: owner,
      repo: repo,
      number: id,
      headers: {Accept: 'application/vnd.github.diff'}
    }, function (err, result) {
      if (err) {
        reject(err);
      } else {
        resolve(result.data);
      }
    });
  });
}

async function filterOwnTeam(
  users: Array<WhitelistUser>,
  owners: Array<string>,
  creator: string,
  org: string,
  github: Object
): Promise<Array<string>> {
  if (!users.some(function(user) {
    return user.skipTeamPrs;
  })) {
    return owners;
  }

  // GitHub does not provide an API to look up a team by name.
  // Instead, get all teams, then filter against those matching
  // our teams list who want to be excluded from their own PR's.
  var teamData = await getTeams(org, github, 0);
  teamData = teamData.filter(function(team) {
    return users.some(function(user) {
        return user.skipTeamPrs && user.name === team.name;
    });
  });
  var promises = teamData.map(function(teamInfo) {
    return getTeamMembership(creator, teamInfo, github);
  });
  var teamMemberships = await Promise.all(promises);
  teamMemberships = teamMemberships.filter(function(membership) {
    return membership.state === 'active';
  });
  return owners.filter(function(owner) {
    return !teamMemberships.find(function(membership) {
        return owner === membership.name;
    });
  });
}

/**
 * While developing/debugging the algorithm itself, it's very important not to
 * make http requests to github. Not only it's going to make the reload cycle
 * much slower, it's also going to temporary/permanently ban your ip and
 * you won't be able to get anymore work done when it happens :(
 */
async function fetch(url: string): Promise<string> {
  const cacheKey = url.replace(/[^a-zA-Z0-9-_\.]/g, '-');
  return cacheGet(cacheKey, () => downloadFileAsync(url, githubAuthCookies));
}

async function cacheGet(
  cacheKey: string,
  getFn: () => Promise<string>
): Promise<string> {
  if (!module.exports.enableCachingForDebugging) {
    return getFn();
  }

  const cacheDir = __dirname + '/cache/';
  if (!fs.existsSync(cacheDir)) {
    fs.mkdir(cacheDir);
  }

  cacheKey = cacheDir + cacheKey;
  if (!fs.existsSync(cacheKey)) {
    const contents = await getFn();
    fs.writeFileSync(cacheKey, contents);
  }
  return readFileAsync(cacheKey, 'utf8');
}

/**
 * If the repo is private than we should only mention users that are still part
 * of that org.
 * Otherwise we could end up with a situation where all the people mentioned have
 * left the org and none of the current staff get notified
**/

async function filterPrivateRepo(
  owners: Array<string>,
  org: string,
  github: Object
): Promise<Array<string>> {
  var currentMembers = await getMembersOfOrg(org, github, 0);

  return owners.filter(function(owner, index) {
    // user passes if they are still in the org
    return currentMembers.some(function(member) {
      return member === owner;
    });
  });
}

async function getPathInfo(
  files: Array<FileInfo>,
  creator: string,
  privateRepo: boolean,
  org: ?string,
  repoConfig: Object,
  github: Object
): Promise<string> {

  var fullPath;
  var filteredPathInfo = [];
  var splitPath;
  var pathInfo = config.pathInfo;
  var foundMatch = false;

  files.filter(function (file) {
    fullPath = file.path;
  });

  if (fullPath.indexOf("/") === -1) {
    filteredPathInfo = pathInfo[0];
  }
  else {
    splitPath = fullPath.split("/");

    while (!foundMatch && splitPath.length > 0) {
      splitPath.pop();
      pathInfo.forEach(function (entry, index) {
        if (entry.path === splitPath.join("/") + "/") {
          filteredPathInfo = pathInfo[index];
          foundMatch = true;
        }
      })
    }
  }
  return filteredPathInfo;
}

async function checkRepoPath(
  repoURL: string,
  id: number,
  creator: string,
  targetBranch: string,
  privateRepo: boolean,
  org: string,
  repoConfig: Object,
  github: Object
): Promise<string> {
  const ownerAndRepo = repoURL.split('/').slice(-2);
  const cacheKey = `${repoURL}-pull-${id}.diff`.replace(/[^a-zA-Z0-9-_\.]/g, '-');
  const diff = await cacheGet(
    cacheKey,
    () => getDiffForPullRequest(ownerAndRepo[0], ownerAndRepo[1], id, github)
  );
  var files = parseDiff(diff);

  // There are going to be degenerated changes that end up modifying hundreds
  // of files. In theory, it would be good to actually run the algorithm on
  // all of them to get the best set of reviewers. In practice, we don't
  // want to do hundreds of http requests. Using the top 5 files is enough
  // to get us 3 people that may have context.
  files.sort(function(a, b) {
    var countA = a.deletedLines.length;
    var countB = b.deletedLines.length;
    return countA > countB ? -1 : (countA < countB ? 1 : 0);
  });
  // remove files that match any of the globs in the file blacklist config
  repoConfig.fileBlacklist.forEach(function(glob) {
    files = files.filter(function(file) {
      return !minimatch(file.path, glob);
    });
  });
  files = files.slice(0, repoConfig.numFilesToCheck);

  return getPathInfo(files, creator, privateRepo, org, repoConfig, github);
}

module.exports = {
  enableCachingForDebugging: false,
  parseDiff: parseDiff,
  checkRepoPath: checkRepoPath,
};

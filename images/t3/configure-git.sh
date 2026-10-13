#!/bin/sh
set -eu
if [ -n "${T3_GIT_IDENTITY_FILE:-}" ]; then
  t3_git_name="$(git config --file "$T3_GIT_IDENTITY_FILE" --get user.name)"
  t3_git_email="$(git config --file "$T3_GIT_IDENTITY_FILE" --get user.email)"
  if [ -z "$t3_git_name" ] || [ -z "$t3_git_email" ]; then
    printf '%s\n' 'Git identity requires user.name and user.email.' >&2
    exit 1
  fi
  if ! git config --global --get user.name >/dev/null; then
    git config --global user.name "$t3_git_name"
  fi
  if ! git config --global --get user.email >/dev/null; then
    git config --global user.email "$t3_git_email"
  fi
fi
if [ -n "${T3_GIT_CREDENTIALS_FILE:-}" ]; then
  git config --global --replace-all credential.helper ''
  git config --global --add credential.helper /usr/local/bin/t3-git-credential
elif [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  git config --global --replace-all credential.https://github.com.helper ''
  git config --global --add credential.https://github.com.helper '!gh auth git-credential'
fi
if [ -z "${T3_GIT_CREDENTIALS_FILE:-}" ] && [ -n "${GH_ENTERPRISE_TOKEN:-${GITHUB_ENTERPRISE_TOKEN:-}}" ]; then
  : "${GH_HOST:?GH_HOST is required for enterprise Git credentials}"
  case "$GH_HOST" in
    *[!a-zA-Z0-9.:-]*|'') printf '%s\n' 'GH_HOST must be a host name with an optional port.' >&2; exit 1 ;;
  esac
  git config --global --replace-all "credential.https://$GH_HOST.helper" ''
  git config --global --add "credential.https://$GH_HOST.helper" '!gh auth git-credential'
fi

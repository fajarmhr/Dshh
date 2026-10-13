//! Shared shapes for bulk file operations — what the file browser's
//! multi-select runs: walking a selection, deleting it, and changing
//! permissions or ownership. The SFTP and FTP modules each implement the
//! operations over their own protocol; the bookkeeping lives here.

use serde::{Deserialize, Serialize};

/// Most entries one walk will collect, so a selection that turns out to be
/// `/` fails cleanly instead of exhausting memory.
pub const MAX_WALK: usize = 200_000;
/// Errors kept verbatim in a report; beyond this they are only counted.
const MAX_ERRORS: usize = 20;

/// A selected entry, as the listing described it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub path: String,
    pub is_dir: bool,
    #[serde(default)]
    pub size: u64,
}

/// One entry found by a walk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// A symbolic link. Walks never descend through one, and recursive
    /// permission changes skip them, as `chmod -R` does.
    pub link: bool,
}

/// Everything under a selection, plus the folders that couldn't be listed.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub entries: Vec<TreeEntry>,
    pub unreadable: Vec<String>,
}

impl Tree {
    /// Start a walk from the selection itself.
    pub fn from_targets(targets: &[Target]) -> Self {
        Tree {
            entries: targets
                .iter()
                .map(|t| TreeEntry {
                    path: t.path.clone(),
                    is_dir: t.is_dir,
                    size: if t.is_dir { 0 } else { t.size },
                    link: false,
                })
                .collect(),
            unreadable: Vec::new(),
        }
    }

    pub fn push(&mut self, entry: TreeEntry) -> Result<(), String> {
        self.entries.push(entry);
        if self.entries.len() > MAX_WALK {
            return Err(format!(
                "More than {MAX_WALK} items under the selection — pick fewer folders"
            ));
        }
        Ok(())
    }

    /// Files and links first, then folders deepest-first: the order a
    /// recursive delete has to go in.
    pub fn delete_order(&self) -> Vec<&TreeEntry> {
        let mut files: Vec<&TreeEntry> = self.entries.iter().filter(|e| !e.is_dir).collect();
        let mut dirs: Vec<&TreeEntry> = self.entries.iter().filter(|e| e.is_dir).collect();
        dirs.sort_by_key(|e| std::cmp::Reverse(depth(&e.path)));
        files.append(&mut dirs);
        files
    }
}

/// Outcome of a bulk operation.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpReport {
    pub files: u32,
    pub dirs: u32,
    pub failed: u32,
    /// The first few failures, as "path: reason".
    pub errors: Vec<String>,
}

impl OpReport {
    pub fn ok(&mut self, is_dir: bool) {
        if is_dir {
            self.dirs += 1;
        } else {
            self.files += 1;
        }
    }

    pub fn fail(&mut self, path: &str, err: impl std::fmt::Display) {
        self.failed += 1;
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(format!("{path}: {err}"));
        }
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn depth(path: &str) -> usize {
    path.trim_end_matches('/').matches('/').count()
}

/// The entries a permission change applies to: the selection, or with
/// `recursive` everything beneath it except symlinks found on the way.
pub fn chmod_targets(tree: &Tree, recursive: bool, roots: usize) -> Vec<&TreeEntry> {
    if recursive {
        tree.entries
            .iter()
            .enumerate()
            .filter(|(i, e)| *i < roots || !e.link)
            .map(|(_, e)| e)
            .collect()
    } else {
        tree.entries.iter().take(roots).collect()
    }
}

/// `chmod -R`'s classic trap is a mode like 644 reaching folders, which locks
/// everyone out of them. With `dir_exec` a folder gets `x` wherever it gets
/// `r` — WinSCP's "add X to directories".
pub fn mode_for(mode: u32, is_dir: bool, dir_exec: bool) -> u32 {
    if is_dir && dir_exec {
        mode | ((mode & 0o444) >> 2)
    } else {
        mode
    }
}

/// `drwxr-sr-x` → `0o2755`; `None` for anything that isn't a POSIX
/// permission string (DOS listings, MLSD facts).
pub fn parse_perm_string(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    if b.len() < 10 {
        return None;
    }
    let mut mode = 0u32;
    for (i, &c) in b[1..10].iter().enumerate() {
        let bit = 1 << (8 - i);
        let special = match i {
            2 => 0o4000,
            5 => 0o2000,
            8 => 0o1000,
            _ => 0,
        };
        match c {
            b'-' => {}
            b'r' if i % 3 == 0 => mode |= bit,
            b'w' if i % 3 == 1 => mode |= bit,
            b'x' if i % 3 == 2 => mode |= bit,
            b's' | b't' if i % 3 == 2 => mode |= bit | special,
            b'S' | b'T' if i % 3 == 2 => mode |= special,
            _ => return None,
        }
    }
    Some(mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perm_strings_parse_with_special_bits() {
        assert_eq!(parse_perm_string("-rw-r--r--"), Some(0o644));
        assert_eq!(parse_perm_string("drwxr-xr-x"), Some(0o755));
        assert_eq!(parse_perm_string("drwxr-sr-x"), Some(0o2755));
        assert_eq!(parse_perm_string("-rwsr-xr-x"), Some(0o4755));
        assert_eq!(parse_perm_string("drwxrwxrwt"), Some(0o1777));
        assert_eq!(parse_perm_string("-rwSr--r--"), Some(0o4644));
        assert_eq!(parse_perm_string("lrwxrwxrwx"), Some(0o777));
        assert_eq!(parse_perm_string("-rw-r--r--+"), Some(0o644));
        assert_eq!(parse_perm_string("10-13-26"), None);
    }

    #[test]
    fn folders_gain_x_where_readable() {
        assert_eq!(mode_for(0o644, true, true), 0o755);
        assert_eq!(mode_for(0o640, true, true), 0o750);
        assert_eq!(mode_for(0o644, false, true), 0o644);
        assert_eq!(mode_for(0o644, true, false), 0o644);
    }

    #[test]
    fn delete_goes_files_then_deepest_folders() {
        let e = |p: &str, d: bool| TreeEntry { path: p.into(), is_dir: d, size: 0, link: false };
        let tree = Tree {
            entries: vec![e("/a", true), e("/a/b", true), e("/a/f", false), e("/a/b/g", false)],
            unreadable: vec![],
        };
        let order: Vec<&str> = tree.delete_order().iter().map(|e| e.path.as_str()).collect();
        assert_eq!(order, ["/a/f", "/a/b/g", "/a/b", "/a"]);
    }

    #[test]
    fn recursive_chmod_skips_links_below_the_selection() {
        let tree = Tree {
            entries: vec![
                TreeEntry { path: "/l".into(), is_dir: false, size: 0, link: true },
                TreeEntry { path: "/d".into(), is_dir: true, size: 0, link: false },
                TreeEntry { path: "/d/link".into(), is_dir: false, size: 0, link: true },
                TreeEntry { path: "/d/f".into(), is_dir: false, size: 0, link: false },
            ],
            unreadable: vec![],
        };
        let paths: Vec<&str> = chmod_targets(&tree, true, 2).iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["/l", "/d", "/d/f"]);
        assert_eq!(chmod_targets(&tree, false, 2).len(), 2);
    }
}

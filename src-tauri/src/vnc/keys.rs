//! Text → key events, for "type the clipboard" into consoles that have no
//! clipboard of their own (QEMU/KVM, BIOS screens, login prompts).
//!
//! Each character maps to an X11 keysym plus, where a US keyboard has it, the
//! XT scancode and whether Shift is held. Scancodes matter for QEMU: with its
//! extended key event the guest sees physical keys, so it doesn't depend on
//! the hypervisor's keymap guessing the right key from a keysym.

pub const SHIFT_KEYSYM: u32 = 0xffe1;
pub const SHIFT_SCANCODE: u32 = 0x2a;
pub const CTRL_KEYSYM: u32 = 0xffe3;
pub const CTRL_SCANCODE: u32 = 0x1d;

const LETTERS: [u32; 26] = [
    0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18,
    0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
];

/// `(keysym, xt scancode or 0, needs shift)` for one typed character.
pub fn char_key(c: char) -> (u32, u32, bool) {
    let (code, shift) = match c {
        '\r' | '\n' => return (0xff0d, 0x1c, false),
        '\t' => return (0xff09, 0x0f, false),
        'a'..='z' => (LETTERS[(c as u8 - b'a') as usize], false),
        'A'..='Z' => (LETTERS[(c as u8 - b'A') as usize], true),
        '1'..='9' => (0x02 + (c as u32 - '1' as u32), false),
        '0' => (0x0b, false),
        ' ' => (0x39, false),
        '!' => (0x02, true),
        '@' => (0x03, true),
        '#' => (0x04, true),
        '$' => (0x05, true),
        '%' => (0x06, true),
        '^' => (0x07, true),
        '&' => (0x08, true),
        '*' => (0x09, true),
        '(' => (0x0a, true),
        ')' => (0x0b, true),
        '-' => (0x0c, false),
        '_' => (0x0c, true),
        '=' => (0x0d, false),
        '+' => (0x0d, true),
        '[' => (0x1a, false),
        '{' => (0x1a, true),
        ']' => (0x1b, false),
        '}' => (0x1b, true),
        ';' => (0x27, false),
        ':' => (0x27, true),
        '\'' => (0x28, false),
        '"' => (0x28, true),
        '`' => (0x29, false),
        '~' => (0x29, true),
        '\\' => (0x2b, false),
        '|' => (0x2b, true),
        ',' => (0x33, false),
        '<' => (0x33, true),
        '.' => (0x34, false),
        '>' => (0x34, true),
        '/' => (0x35, false),
        '?' => (0x35, true),
        _ => (0, false),
    };
    (keysym_for_char(c), code, shift)
}

/// X11 keysym for a character: Latin-1 maps to itself, everything else to
/// the Unicode keysym range.
pub fn keysym_for_char(c: char) -> u32 {
    let cp = c as u32;
    if (0x20..=0x7e).contains(&cp) || (0xa0..=0xff).contains(&cp) {
        cp
    } else {
        0x0100_0000 | cp
    }
}

/// QEMU's extended key event wants extended (0xE0-prefixed) scancodes folded
/// into one byte with the high bit set.
pub fn qemu_keycode(xt: u32) -> u32 {
    if xt >> 8 == 0xe0 && (xt & 0xff) < 0x7f {
        (xt & 0x7f) | 0x80
    } else {
        xt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_digits_and_shifted_symbols() {
        assert_eq!(char_key('a'), (0x61, 0x1e, false));
        assert_eq!(char_key('Z'), (0x5a, 0x2c, true));
        assert_eq!(char_key('0'), (0x30, 0x0b, false));
        assert_eq!(char_key('!'), (0x21, 0x02, true));
        assert_eq!(char_key('\n'), (0xff0d, 0x1c, false));
    }

    #[test]
    fn non_ascii_has_keysym_but_no_scancode() {
        assert_eq!(char_key('é'), (0xe9, 0, false));
        assert_eq!(char_key('€'), (0x0100_20ac, 0, false));
    }

    #[test]
    fn extended_scancodes_fold_high_bit() {
        assert_eq!(qemu_keycode(0xe053), 0xd3); // Delete
        assert_eq!(qemu_keycode(0xe048), 0xc8); // Up
        assert_eq!(qemu_keycode(0x1d), 0x1d);
    }
}

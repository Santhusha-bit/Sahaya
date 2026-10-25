# Team photos

Drop each team member's photo into this folder using the exact filenames below.
The Team section renders them automatically. If a file is missing, the card
gracefully falls back to a gradient initials avatar, so nothing breaks.

| File                            | Person                 | LinkedIn |
| ------------------------------- | ---------------------- | -------- |
| `santhusha.png`     | Santhusha Mudannayaka  | https://www.linkedin.com/in/santhusha-mudannayaka/ |
| `pranav.jpg`        | Pranav Virmalwar       | https://www.linkedin.com/in/pranav-virmalwar-351038195/ |
| `keshan.jpg`        | Keshan De Silva        | https://www.linkedin.com/in/keshan-desilva/ |

## How to get each photo from LinkedIn

LinkedIn photos cannot be fetched automatically (LinkedIn blocks it, and its
image URLs are short-lived signed links). Save them manually:

1. Open the LinkedIn profile.
2. Click the profile photo to enlarge it, then right-click → "Save image as…"
   (or take a square screenshot).
3. Save it here with the exact filename from the table above.

Square images (for example 400×400 or larger) look best; they are cropped to a
circle with `object-cover`. `.jpg`, `.png`, or `.webp` all work as long as the
filename (including extension) matches `src/components/sections/Team.tsx`.
</content>

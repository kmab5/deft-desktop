# Deft

Deft is an offline Android reader that records the reader's own reading life: what they read, how long, and how it went.

## Library

**Book**:
One distinct piece of content, identified by the exact contents of its file. Two different files are two different books, even if they are the same title.
_Avoid_: Title, item, edition

**Book file**:
A place on the device where a book's content was found. One book can have several.
_Avoid_: Copy, path

**Missing**:
A book none of whose book files can currently be found. It keeps all its history.
_Avoid_: Deleted, removed

**Ignored**:
A book the reader marked as not a book (a manual, a receipt). Hidden everywhere and left out of stats; reversible.
_Avoid_: Hidden, archived

**Forget**:
The only way a book and its history are permanently removed.
_Avoid_: Delete, remove

**Protected**:
A book whose file is locked by DRM. Deft lists it but cannot open it.
_Avoid_: Encrypted, locked

**Excluded folder**:
A subfolder inside a library folder whose files Deft deliberately does not scan.

## Organising

**Category**:
A reader-made collection of books, such as a TBR list or a book club pick. Names may repeat.
_Avoid_: List, shelf, collection, tag

**Type**:
A reader-made label for categories (TBR, Book club…). **Series** is the one built-in type.
_Avoid_: Tag, kind

**Series**:
A category of type Series, whose books have numbered positions (1, 2, 2.5…).

**Author**:
A person credited on a book, gathered automatically and mergeable when spelled differently.

## Reading

**Reading state**:
Where a book stands: not read, reading, finished, paused or abandoned.
_Avoid_: Status, shelf

**Read-through**:
One attempt at reading a book from start to an outcome. A re-read is a new read-through.
_Avoid_: Read, attempt, cycle

**Session**:
One continuous stretch of active reading inside the reader. Idle time is not part of it.
_Avoid_: Sitting, timer

**Browsing**:
Reading time spent in a finished book without starting a re-read. Recorded, but kept out of stats.

**Idle timeout**:
How long without interaction before a session stops counting time.

**Resolved**:
A book that counts as done for progress: only finished books. Abandoned books are unresolved.

## Notes

**Highlight**:
A marked passage of text, optionally with a note.

**Bookmark**:
A saved place in a book.

**Page note**:
A note attached to a whole page of a PDF, DjVu or CBZ book.

## Exchange

**Edition match**:
The reader-confirmed link between a book and a published edition (ISBN and catalogue IDs).
_Avoid_: Metadata lookup, enrichment

**Reading profile**:
The exported summary of a reader's books, ratings and history, meant for the future social app.
_Avoid_: Profile export, account

**Backup**:
A zip of all Deft data (never the book files) that can restore Deft on another device.

## Moments

**Personal best**:
A reader's own record, such as their longest session or fastest finish. Always shown in purple.
_Avoid_: Record, achievement, badge

**Celebration**:
The animated moment Deft plays when something worth marking happens (a book finished, a goal reached). It can be switched off.
_Avoid_: Reward, achievement, confetti

# Questions and troubleshooting

## The Board, Notes and Calendar buttons are not in Gmail

Reload the Gmail tab. If they are still missing, check MemDesk's setup page
has not hidden them: right-click its icon in Chrome's toolbar and choose
**Options**.

If that is not it, Gmail may have changed its page. MemDesk still opens
from its icon in Chrome's toolbar, or with **Alt+Shift+K**. Please
[report it](https://github.com/michaelbeijer/MemDesk/issues).

## MemDesk says the extension was updated

Reload the Gmail tab. After MemDesk is updated, a Gmail tab that was
already open needs reloading before MemDesk works in it again.

## Google says it "hasn't verified this app"

That is because Google has not reviewed MemDesk yet, not because something
is wrong. Click **Advanced**, then **Go to MemDesk**. If you set up your
own copy, Google says this about your own project too.

## Gmail asks me to connect again

Click **Connect Gmail** on the board. Google asks you to sign in again
after a while, as it does everywhere.

## The calendar says Google Tasks or Google Calendar "was not allowed"

Google's page lets you untick each permission. Click **Connect again** and
leave both ticked.

## The calendar says it needs my permission

Click **Connect again** in Chrome, or **Allow** in the phone app, and allow
it on Google's page.

## The phone app says "Sorry, unable to open the file at this time"

Chrome on your phone is signed in to more than one Google account, and
opened the app as another one. Open the link in an Incognito tab, or in a
Chrome profile with just this account.

## I moved a card out of Done, and the email did not come back to my Inbox

MemDesk never puts mail in your Inbox. To bring an email back, open it in
Gmail and move it to the Inbox there.

## An email on Done is back in my Inbox

When someone replies to a conversation you archived, Gmail brings it back to
your Inbox. The card stays where it was on the board, so you can see the
reply and decide where it goes next.

## I removed a column. Is my mail gone?

No. Removing a column only takes it off the board. Its Gmail label, and the
mail filed under it, are left untouched.

## I renamed a board label in Gmail

That is fine. Each column follows its label even when it is renamed in
Gmail, so the board does not make a new, empty one. The notes follow
`_Notes` in the same way.

## A column says "Showing the first 100 threads"

Each column loads up to 100 conversations. Move the ones you have finished
with to Done, or take them off the board.

## Saving a card edit says Chrome's synced storage is full

Your own card titles, notes and colours are kept in Chrome's sync storage,
which is small. There is room for hundreds of edited cards, fewer if each
has a long note. Taking a card off the board deletes its edit; moving it to
Done keeps it. Clear the notes on cards you no longer need, or take
finished cards off the board.

## I deleted a note by mistake

Click **Undo** straight away. Later, the note is in Gmail's Trash for 30
days: open it there and copy the text back.

## Setting up my own copy went wrong

[SETUP.md](../SETUP.md#when-something-goes-wrong) has a table of what Google
might say during setup, and what it means.

## Where can I ask a question?

On [GitHub](https://github.com/michaelbeijer/MemDesk/issues), or through
[beijer.uk/contact](https://beijer.uk/contact/).

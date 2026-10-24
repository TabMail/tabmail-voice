## ADR-DESK-025: Contacts, the third app the Answer tool reaches

**Context:** Owner, 2026-09-26: the Answer tool looks people up in the user's contacts and adds
them (the backend's `contacts_search` and `contacts_add` in its `macos` registry), under the same
rules as Calendar and Reminders (ADR-DESK-024): one switch, on by default, in Settings and the
wizard; adding asks first; access is asked on first use and a refusal says where to allow it. First
built in the Swift app; built here in the Electron app (ADR-DESK-032).

**Decision:**
- The `contacts` connector, with `src/core/agent/connectors/contacts.ts`: `ContactsSearchTool` and
  `ContactsAddTool` over a `ContactStore` interface. On macOS the store is `voice-macos`
  (`ContactStore.swift`, the Contacts framework); elsewhere there is none.
- A search matches a contact's name (either way round), company or an email address, ignoring case
  and accents (`ContactMatch`), in the user's sort order. The helper matches, reading every contact
  it enumerates (the framework's name predicate matches neither email addresses nor accents) and
  stopping at the limit, so the address book never crosses the wire. The model sees at most
  `config.contactsSearchMaxResults`; the tool asks for one more to say that more match. Phone numbers
  are returned, not searched.
- `contacts_add` needs a name, a company or an email address; one email address and one phone
  number, as the backend's schema gives them. The question and the contact come from one `draft`,
  and every field added is shown (ADR-DESK-024). It goes to the default container.
- Access is asked on first use (`CNContactStore.requestAccess`); without it (a request that fails
  counts as a refusal) the helper refuses with `contactsNoAccess`, which becomes a
  `ContactStoreError` naming System Settings › Privacy & Security › Contacts. A call waits `config.contactStoreRequestTimeout`, as long as Calendar's, for
  the prompt. The framework's calls block, so the helper runs them off its main thread.
- The packaged app carries `NSContactsUsageDescription`; the hardened runtime gets
  `com.apple.security.personal-information.addressbook`.

**Consequences:**
- Matches go to the model only: nothing is stored (ADR-004).
- A search reads the whole address book in the helper when fewer than the limit match; fine for a
  personal one, and the model's results stay capped.
- The permission prompt raised from the helper is checked by hand on a signed build (TESTS.md).


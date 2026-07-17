# Sprint 2 — Add Employee regenerated output (manual inspection)

Requirement: **Create Employee** · scenarios: **29**

Legend: 🟢 Automation Ready · 🟡 Needs Review · intent shown per scenario.

### 1. 🟢 Create a record with valid data
- id: `crud-pos-create` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Emma" in the First Name field
  3. Enter "Rose" in the Middle Name field
  4. Enter "Smith" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

### 2. 🟡 Direct URL / API access is authorization-checked
- id: `crud-neg-direct-endpoint-authz` · intent: **held:direct_url** · placeholder: no
- steps:
  1. Request the Create Employee URL directly (bypassing the normal in-app navigation)
  2. Use a session that is NOT authorized for this operation
  3. Verify the direct request is rejected or redirected by a server-side authorization check (not merely hidden in the UI)
  4. Verify the Employee resource is inaccessible and no Employee record is created
- ⚠️ review: Deterministic direct_url step flow (non-form intent): the steps assert an access-control / session outcome rather than filling the feature form, so they ground on no selector and depend on an environment-specific account or precondition. Confirm the required account and expected access control against the target environment before automating.

### 3. 🟡 Unauthenticated user is redirected to login
- id: `crud-neg-unauthenticated-redirect` · intent: **held:authentication** · placeholder: no
- steps:
  1. Open the Create Employee page while not authenticated (no active session)
  2. Verify the request is redirected to the login page before the form is reachable
  3. Verify the Create Employee form is not shown until the user authenticates
- ⚠️ review: Deterministic authentication step flow (non-form intent): the steps assert an access-control / session outcome rather than filling the feature form, so they ground on no selector and depend on an environment-specific account or precondition. Confirm the required account and expected access control against the target environment before automating.

### 4. 🟢 Cancel discards input and returns without saving
- id: `crud-pos-cancel-discards` · intent: **navigation** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Sophia" in the First Name field
  3. Enter "James" in the Middle Name field
  4. Enter "Chen" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Cancel button
  7. Return to the list and confirm the record was NOT created (the entered data was discarded)

### 5. 🟢 Created record is immediately searchable
- id: `crud-pos-searchable` · intent: **search** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "David" in the First Name field
  3. Enter "James" in the Middle Name field
  4. Enter "Chen" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button
  7. Open the records list / search page
  8. Search for the newly created record (by its identifier and by name)
  9. Confirm the newly created record appears in the search results

### 6. 🟢 Partial-name search returns the record
- id: `crud-pos-search-partial` · intent: **search** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Emma" in the First Name field
  3. Enter "James" in the Middle Name field
  4. Enter "Smith" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button
  7. Open the records list / search page
  8. Search for the newly created record (by its identifier and by name)
  9. Confirm the newly created record appears in the search results

### 7. 🟢 Search is case-insensitive
- id: `crud-pos-search-case-insensitive` · intent: **search** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Priya" in the First Name field
  3. Enter "Dev" in the Middle Name field
  4. Enter "Garcia" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button
  7. Open the records list / search page
  8. Search for the newly created record (by its identifier and by name)
  9. Confirm the newly created record appears in the search results

### 8. 🟢 New record propagates to dependent views
- id: `crud-pos-propagate-views` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "David" in the First Name field
  3. Enter "Rose" in the Middle Name field
  4. Enter "Johnson" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

### 9. 🟢 Valid file upload is accepted and stored
- id: `crud-pos-upload-valid` · intent: **file_upload** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "David" in the First Name field
  3. Enter "Marie" in the Middle Name field
  4. Enter "Chen" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

### 10. 🟢 Invalid / unsupported file format is rejected
- id: `crud-neg-upload-format` · intent: **file_upload** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter an invalid First Name in the First Name field
  3. Enter an invalid Middle Name in the Middle Name field
  4. Enter an invalid Last Name in the Last Name field
  5. Upload an invalid file type (e.g. "virus.exe") for the Profile Photo
  6. Click the Save button

### 11. 🟢 Corrupted / malformed file is handled gracefully
- id: `crud-edge-upload-corrupt` · intent: **file_upload** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a boundary/edge First Name (empty, whitespace, or unusual case) in the First Name field
  3. Enter a boundary/edge Middle Name (empty, whitespace, or unusual case) in the Middle Name field
  4. Enter a boundary/edge Last Name (empty, whitespace, or unusual case) in the Last Name field
  5. Upload a corrupted image file (valid extension, unreadable content) for the Profile Photo
  6. Click the Save button

### 12. 🟢 Missing required fields are rejected
- id: `crud-neg-required-fields` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a blank First Name (leave it empty) in the First Name field
  3. Enter a blank Middle Name (leave it empty) in the Middle Name field
  4. Enter a blank Last Name (leave it empty) in the Last Name field
  5. Upload a blank Profile Photo (leave it empty) for the Profile Photo
  6. Click the Save button

### 13. 🟢 Invalid field formats are rejected
- id: `crud-neg-invalid-format` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter an invalid First Name in the First Name field
  3. Enter an invalid Middle Name in the Middle Name field
  4. Enter an invalid Last Name in the Last Name field
  5. Upload an invalid file type (e.g. "virus.exe") for the Profile Photo
  6. Click the Save button

### 14. 🟢 Re-submitting the same form does not create a duplicate
- id: `crud-neg-double-submit` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a First Name that already exists (a duplicate of an existing record) in the First Name field
  3. Enter a Middle Name that already exists (a duplicate of an existing record) in the Middle Name field
  4. Enter a Last Name that already exists (a duplicate of an existing record) in the Last Name field
  5. Upload a Profile Photo that already exists (a duplicate of an existing record) for the Profile Photo
  6. Click the Save button

### 15. 🟢 Field length / value boundaries
- id: `crud-edge-boundary-lengths` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a First Name containing numbers (e.g. "John123") in the First Name field
  3. Enter a Middle Name containing numbers (e.g. "John123") in the Middle Name field
  4. Enter a Last Name containing numbers (e.g. "John123") in the Last Name field
  5. Upload a Profile Photo containing numbers (e.g. "John123") for the Profile Photo
  6. Click the Save button

### 16. 🟢 Operate on a non-existent / already-deleted record
- id: `crud-neg-delete-nonexistent` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a blank First Name (leave it empty) in the First Name field
  3. Enter a blank Middle Name (leave it empty) in the Middle Name field
  4. Enter a blank Last Name (leave it empty) in the Last Name field
  5. Upload a blank Profile Photo (leave it empty) for the Profile Photo
  6. Click the Save button

### 17. 🟢 Whitespace-only required fields are rejected
- id: `crud-neg-whitespace-only` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a whitespace-only First Name (e.g. "   ") in the First Name field
  3. Enter a whitespace-only Middle Name (e.g. "   ") in the Middle Name field
  4. Enter a whitespace-only Last Name (e.g. "   ") in the Last Name field
  5. Upload a whitespace-only Profile Photo (e.g. "   ") for the Profile Photo
  6. Click the Save button

### 18. 🟡 Unauthorized user cannot perform the operation
- id: `crud-neg-unauthorized` · intent: **held:authorization** · placeholder: no
- steps:
  1. Attempt to open the Create Employee page
  2. Use a user account that is NOT authorized to perform this operation
  3. Verify access is denied (the operation is blocked with a forbidden / access-denied response)
  4. Verify no Employee record is created or modified
- ⚠️ review: Deterministic authorization step flow (non-form intent): the steps assert an access-control / session outcome rather than filling the feature form, so they ground on no selector and depend on an environment-specific account or precondition. Confirm the required account and expected access control against the target environment before automating.

### 19. 🟢 SQL-injection input is rejected safely
- id: `crud-neg-injection-sql` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter the SQL-injection string "' OR 1=1 --" in the First Name field
  3. Enter the SQL-injection string "' OR 1=1 --" in the Middle Name field
  4. Enter the SQL-injection string "' OR 1=1 --" in the Last Name field
  5. Upload the SQL-injection string "' OR 1=1 --" for the Profile Photo
  6. Click the Save button

### 20. 🟢 XSS / script payload is escaped, not executed
- id: `crud-neg-injection-xss` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter the XSS payload "<script>alert(1)</script>" in the First Name field
  3. Enter the XSS payload "<script>alert(1)</script>" in the Middle Name field
  4. Enter the XSS payload "<script>alert(1)</script>" in the Last Name field
  5. Upload the XSS payload "<script>alert(1)</script>" for the Profile Photo
  6. Click the Save button

### 21. 🟢 First Name containing only whitespace is rejected
- id: `field-first-name-whitespace` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a whitespace-only First Name (e.g. "   ") in the First Name field
  3. Enter a whitespace-only Middle Name (e.g. "   ") in the Middle Name field
  4. Enter a whitespace-only Last Name (e.g. "   ") in the Last Name field
  5. Upload a whitespace-only Profile Photo (e.g. "   ") for the Profile Photo
  6. Click the Save button

### 22. 🟢 Last Name containing only whitespace is rejected
- id: `field-last-name-whitespace` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a whitespace-only First Name (e.g. "   ") in the First Name field
  3. Enter a whitespace-only Middle Name (e.g. "   ") in the Middle Name field
  4. Enter a whitespace-only Last Name (e.g. "   ") in the Last Name field
  5. Upload a whitespace-only Profile Photo (e.g. "   ") for the Profile Photo
  6. Click the Save button

### 23. 🟢 All required fields blank is rejected
- id: `field-all-required-blank` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a blank First Name (leave it empty) in the First Name field
  3. Enter a blank Middle Name (leave it empty) in the Middle Name field
  4. Enter a blank Last Name (leave it empty) in the Last Name field
  5. Upload a blank Profile Photo (leave it empty) for the Profile Photo
  6. Click the Save button

### 24. 🟢 Numeric digits in the first name are handled per rule
- id: `field-first-name-numeric` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter a First Name containing numbers (e.g. "John123") in the First Name field
  3. Enter a Middle Name containing numbers (e.g. "John123") in the Middle Name field
  4. Enter a Last Name containing numbers (e.g. "John123") in the Last Name field
  5. Upload a Profile Photo containing numbers (e.g. "John123") for the Profile Photo
  6. Click the Save button

### 25. 🟢 An authorized admin, when a valid employee is submitted,…
- id: `req-step-1` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Miguel" in the First Name field
  3. Enter "Lee" in the Middle Name field
  4. Enter "Kumar" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

### 26. 🟢 Admin can add a new employee by entering first…
- id: `req-step-2` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Sophia" in the First Name field
  3. Enter "James" in the Middle Name field
  4. Enter "Johnson" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

### 27. 🟢 Employee ID may be auto-generated
- id: `req-step-3` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Aarav" in the First Name field
  3. Enter "Anne" in the Middle Name field
  4. Enter "Patel" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

### 28. 🟢 On save the employee is created and becomes searchable…
- id: `req-step-4` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "David" in the First Name field
  3. Enter "Rose" in the Middle Name field
  4. Enter "Chen" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

### 29. 🟢 Only authorized admins may access the form
- id: `req-step-5` · intent: **form_entry** · placeholder: no
- steps:
  1. Open the page under test
  2. Enter "Priya" in the First Name field
  3. Enter "Dev" in the Middle Name field
  4. Enter "Garcia" in the Last Name field
  5. Upload a valid image file (e.g. "profile.jpg") for the Profile Photo
  6. Click the Save button

---
## Summary

- Placeholder steps: **0** (target 0)
- Automation Ready: **26/29** (90%)
- Needs Review (held non-form intents + any ungrounded): **3**

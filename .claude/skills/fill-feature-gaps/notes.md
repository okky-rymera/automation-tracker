# Notes for features that are not filled yet

Earlier fill runs found these facts for OTHER features. They did not write them.
The skill passes the section `## F-<id>` to the run for that feature. A run can find a fact wrong or already done.
After a feature is filled, delete its section. Add new findings under the target feature (make the section if needed).
Items for a person (decisions, bugs) go under "## For a person": the skill does not pass them to a run.

## F-2
- Settings: Price tab > "Wholesale Price Text" field, free text, default "Wholesale Price:". (from F-5)
- The checkout block and the mini cart block show no "Wholesale Price:" label, as the cart block. (from F-5)

## F-6
- Settings: the "Show Wholesale Price to non-wholesale users" switch (Enabled / Disabled), default Disabled; "Locations" (Shop Archives, Single Product, both checked by default); "Click to See Wholesale Prices Text", default "See wholesale prices"; the wholesale role list, default Wholesale Customer. (from F-5)
- Guest scopes S-47, S-54, S-441 need: 'The "Hide Price and Add to Cart button" checkbox is unchecked (the default, see F-4)'. (from F-4)
- The "See wholesale prices" link never shows in the Store API; the code adds it only on shop, category and product pages. (from F-14)

## F-17
- Settings: "Allowed roles" multi-select (Admin Roles tab) of roles that can edit posts, default Shop manager. It changes only who sees the menu, not who can save (F-13). (from F-13)

## F-36
- A preview as a wholesale role also hides the coupon field when the F-3 checkbox is checked (F-3 S-1038 covers it). (from F-3)

## F-40
- Each activation of the plugin restarts the 21-day wait of the toolbar popup (F-53 S-1059). Add a scope. (from F-53)

## F-63
- Its out-of-scope line says that hiding the crossed-out price is a Premium setting. Wrong: the free "Hide Retail Price" checkbox (F-7) hides it on grouped products (F-7 S-987, seen on the site). (from F-7, F-5)
- S-667 needs 'The "Hide Retail Price" checkbox is unchecked (the default, see F-7)'. (from F-7)
- A shop manager who sends `wholesale_role` gets the regular price for a grouped product (simple and variable products work). See the open question on F-14. (from F-14)

## F-74
- The save-action handlers (group_save, group_edit, group_delete) use a Premium constant; with only the free plugin active a group_save request can fail. From the code only. (from F-13)

## F-79
- S-613: the redirect after activation also hides the Getting Started notice (F-53 S-614), so the notice stays only after a WP-CLI or bulk activation. (from F-53)

## F-97
- S-966 needs 'The "Hide Retail Price" checkbox is unchecked (the default, see F-7)'. The checked box also removes the text before the regular price. (from F-7)

## F-104
- Add a scope: "the default wholesale role was deleted between the preview and the import": the row fails with "The default wholesale role no longer exists…". Only Premium can delete a role. (from F-19)

## For a person
- No feature owns the Price tab setting "Variable Product Price Display" (Price Range / Minimum Price (Premium) / Maximum Price (Premium)). F-13 S-1048 names it with no feature ID.
- No feature covers the "Add additional wholesale price levels" upsell popup in the product editor (an Upsells feature, next to F-30 or F-84).
- F-5 (filled): its out-of-scope line "External/Affiliate products keep the regular price" may be wrong: quick edit accepts a wholesale price on external products. A price above the regular price is saved (F-101 S-1005); the shop display was not checked.
- F-4 note 77 (Elementor "Product Price" widget) needs Elementor: it belongs in an Integration feature. F-4 note 76 says the same as new scope S-1018: a person can delete the note.
- F-3: the old block variations of S-16, S-17, S-19, S-20 have an empty "Version" value; a person can set "Block". Note 48 is a testable rule and could be a scope.
- F-3: a person deleted IMG-92 (classic cart after wholesale login); IMG-284 shows the same screen. F-5: IMG-27 is a cropped copy of IMG-118.
- Bug #1126 (guest coupon stays after wholesale login on block pages): likely cause, the issue-880 fix hooks the cleanup before WooCommerce loads the coupons (class-wc-cart-session.php line 115 hook, line 118 coupons). Worth adding to the issue.
- F-34 S-373 has no screenshot: it needs WooCommerce 11.3.1 on the test site.
- F-53 (filled): its note on WordPress 6.5 could add that WP-CLI can still turn WooCommerce off, and the F-34 S-375 notice then shows.
- F-5 (filled): question 1675 (All Products block) now lives on F-14 with its cause; the F-5 question can go.
- F-7 (filled): the "Hide Retail Price" style for blocks loads only on pages with the cart or checkout block, so the mini cart block on other pages probably still shows the crossed-out price (code only).

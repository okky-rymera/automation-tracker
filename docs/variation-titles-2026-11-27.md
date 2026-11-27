# Variation titles: scope descriptions that changed (27 Nov 2026)

On 27 Nov 2026 each variation got its own title. Results that were for one variation only moved from the scope description into the variation titles.
This file lists each scope whose description changed: the old text, the new text, and the new variation titles. Use it to check that no fact was lost.

## F-1/S-1230 The column stays empty for a grouped or an external product

**Old:** The column uses only simple products, variable products and variations. A grouped product stays empty also when its child products have wholesale prices. An external product stays empty also when quick edit saved a wholesale price on it (see F-90 S-1220).

**New:** The column uses only simple products, variable products and variations. Quick edit can save a wholesale price on an external product (see F-90 S-1220).

**Variation titles:**

- SV-1231 (Grouped product): The Wholesale Price column stays empty for a grouped product, also when its child products have wholesale prices
- SV-1232 (External product): The Wholesale Price column stays empty for an external product, also when quick edit saved a wholesale price on it

## F-2/S-1076 The new text shows before the wholesale price of other product types and on other pages

**Old:** The text shows in the same place as the default "Wholesale Price:" label. A variable or grouped product shows it before the price range, for example "Bulk Price: $40.00 - $55.00". On the shortcode cart page it shows in the Price column, under the crossed-out regular price. On the admin product list, the admin sees it in the "Wholesale Price" column, under the role name (the column is F-1).

**New:** The text shows in the same place as the default "Wholesale Price:" label. The "Wholesale Price" column of the admin product list is F-1.

**Variation titles:**

- SV-1077 (Shop page, Variable product): The shop page shows the new text before the price range of a variable product, for example "Bulk Price: $40.00 - $55.00"
- SV-1078 (Shop page, Grouped product): The shop page shows the new text before the price range of a grouped product
- SV-1079 (Product page, Variable product): The product page shows the new text before the price range of a variable product
- SV-1080 (Product page, Variation): The product page shows the new text before the wholesale price of a variation
- SV-1081 (Cart page, Simple product): The shortcode cart page shows the new text in the Price column of a simple product, under the crossed-out regular price
- SV-1082 (Cart page, Variation): The shortcode cart page shows the new text in the Price column of a variation, under the crossed-out regular price
- SV-1083 (Product Collection block, Simple product): The Product Collection block shows the new text before the wholesale price of a simple product
- SV-1084 (Product Collection block, Variable product): The Product Collection block shows the new text before the price range of a variable product
- SV-1085 (Admin product list, Simple product): The admin product list shows the new text in the "Wholesale Price" column of a simple product, under the role name
- SV-1086 (Admin product list, Variable product): The admin product list shows the new text in the "Wholesale Price" column of a variable product, under the role name

## F-3/S-16 Wholesale customer does not see the coupon field

**Old:** Block pages: the "Add coupons" link is not in the Cart totals or in the Checkout order summary. Shortcode pages: the cart has no "Coupon code" field and no "Apply coupon" button, and the checkout has no "Have a coupon? Click here to enter your code" bar.

**New:** Each cart and checkout page hides its own coupon control.

**Variation titles:**

- SV-977 (Cart, Block): Wholesale customer sees no "Add coupons" link in the Cart totals of the block cart
- SV-978 (Checkout, Block): Wholesale customer sees no "Add coupons" link in the order summary of the block checkout
- SV-1025 (Cart, Shortcode): Wholesale customer sees no "Coupon code" field and no "Apply coupon" button on the shortcode cart
- SV-1026 (Checkout, Shortcode): Wholesale customer sees no "Have a coupon? Click here to enter your code" bar on the shortcode checkout

## F-3/S-17 Regular customer still sees the coupon field

**Old:** Block pages: the "Add coupons" link shows in the Cart totals and in the Checkout order summary. Shortcode pages: the cart shows the "Coupon code" field with the "Apply coupon" button, and the checkout shows the "Have a coupon? Click here to enter your code" bar.

**New:** Each cart and checkout page still shows its own coupon control.

**Variation titles:**

- SV-979 (Cart, Block): Regular customer sees the "Add coupons" link in the Cart totals of the block cart
- SV-980 (Checkout, Block): Regular customer sees the "Add coupons" link in the order summary of the block checkout
- SV-1027 (Cart, Shortcode): Regular customer sees the "Coupon code" field and the "Apply coupon" button on the shortcode cart
- SV-1028 (Checkout, Shortcode): Regular customer sees the "Have a coupon? Click here to enter your code" bar on the shortcode checkout

## F-4/S-30 Guest sees "Login to see prices" in place of the price and the buy controls on the product page

**Old:** Simple product: the Add to cart button does not show. Variable product: the guest can choose the options, but no variation price, stock text, quantity box or Add to cart button shows. Grouped product: the list of child products, with their prices, quantity boxes and the Add to cart button, does not show. External product: the button to the external site (for example "Buy product") does not show.

**New:** Each product type hides its own buy controls. The guest sees the "Login to see prices" link in their place.

**Variation titles:**

- SV-1708 (Variable product): Guest can choose the options of a variable product, but sees no variation price, stock text, quantity box or Add to cart button
- SV-1709 (Simple product): Guest sees no price and no Add to cart button on a simple product
- SV-1710 (Grouped product): Guest sees no list of child products, prices, quantity boxes or Add to cart button on a grouped product
- SV-1711 (External product): Guest sees no price and no button to the external site on an external product

## F-4/S-1011 Products that a guest added to the cart before the box was checked are removed from the cart

**Old:** On the next page load, WooCommerce removes each product and shows: "<product name> has been removed from your cart because it can no longer be purchased. Please contact us if you need assistance." The cart is then empty. The checkout block opens the cart page instead, with the same notice. The mini cart widget in the header shows "0 items", and the mini cart block shows no count.

**New:** On the next page load, WooCommerce removes each product and shows: "<product name> has been removed from your cart because it can no longer be purchased. Please contact us if you need assistance." The cart is then empty.

**Variation titles:**

- SV-1012 (Cart page, Shortcode): The cart page shows the "has been removed from your cart" notice and an empty cart
- SV-1013 (Cart page, Block): The cart block shows the "has been removed from your cart" notice and an empty cart
- SV-1014 (Checkout page, Shortcode): The checkout page shows the "has been removed from your cart" notice
- SV-1015 (Checkout page, Block): The checkout block opens the cart page, with the "has been removed from your cart" notice
- SV-1016 (Mini cart, Widget): The mini cart widget in the header shows "0 items"
- SV-1017 (Mini cart, Block): The mini cart block shows no item count

## F-4/S-1712 Logged-in customer still sees the price and the buy controls on the product page

**Old:** Simple product: the price and the Add to cart button show. Variable product: after the customer chooses the options, the variation price, stock amount, quantity box and Add to cart button show. Grouped product: the list of child products, with their prices, quantity boxes and the Add to cart button, shows. External product: the price and the button to the external site (for example "Buy product") show.

**New:** The hide setting does not change the product page for a logged-in customer. Each product type shows its normal price and buy controls.

**Variation titles:**

- SV-1713 (Simple product): Logged-in customer sees the price and the Add to cart button on a simple product
- SV-1714 (Variable product): Logged-in customer sees the variation price, stock amount, quantity box and Add to cart button after choosing the options of a variable product
- SV-1715 (Grouped product): Logged-in customer sees the list of child products, with their prices, quantity boxes and the Add to cart button, on a grouped product
- SV-1716 (External product): Logged-in customer sees the price and the button to the external site on an external product

## F-5/S-317 Wholesale customer sees the discounted wholesale price of a percentage discount

**Old:** The discount is taken off the regular price, for example 10% off $150.00 shows $135.00. The shop page and the product page show it under the crossed-out regular price. The cart shows the saved discounted price.

**New:** The discount is taken off the regular price, for example 10% off $150.00 shows $135.00.

**Variation titles:**

- SV-972 (Shop page): The shop page shows the discounted wholesale price of a percentage discount under the crossed-out regular price
- SV-973 (Product page): The product page shows the discounted wholesale price of a percentage discount under the crossed-out regular price
- SV-974 (Cart page): The cart page shows the discounted wholesale price of a percentage discount as the saved item price

## F-5/S-733 Wholesale customer sees the wholesale price with the regular price crossed out

**Old:** On the shop page, the product page, the shortcode cart page, the mini cart widget, the grouped product table and the Product Collection block, the wholesale price shows under the crossed-out regular price, after the "Wholesale Price:" label. The cart block, the checkout block and the mini cart block show the crossed-out regular price and the wholesale price side by side, with no label. They also show the amount saved, for example "Save $50.00". The shortcode checkout page shows only the line subtotal at the wholesale price, with no crossed-out price. This works for simple products and variations. On the cart page and the checkout page, the linked tests check only the wholesale price and the line subtotal. No test checks the crossed-out regular price there.

**New:** This works for simple products and variations. On the cart page and the checkout page, the linked tests check only the wholesale price and the line subtotal. No test checks the crossed-out regular price there.

**Variation titles:**

- SV-44 (Shop page): The shop page shows the wholesale price under the crossed-out regular price, after the "Wholesale Price:" label
- SV-41 (Product page): The product page shows the wholesale price under the crossed-out regular price, after the "Wholesale Price:" label
- SV-37 (Cart page): The cart page shows the wholesale price under the crossed-out regular price, after the "Wholesale Price:" label, and the cart block shows them side by side with the amount saved
- SV-426 (Checkout page): The checkout page shows only the line subtotal at the wholesale price, with no crossed-out price, and the checkout block shows the crossed-out regular price and the wholesale price side by side with the amount saved
- SV-991 (Mini cart): The mini cart widget shows the wholesale price under the crossed-out regular price, after the "Wholesale Price:" label, and the mini cart block shows them side by side with the amount saved
- SV-992 (Grouped product page): The grouped product table shows the wholesale price under the crossed-out regular price, after the "Wholesale Price:" label
- SV-993 (Product Collection block): The Product Collection block shows the wholesale price under the crossed-out regular price, after the "Wholesale Price:" label

## F-5/S-735 A product with no wholesale price keeps its regular price for a wholesale customer

**Old:** The product shows only its regular price: no "Wholesale Price:" line and no crossed-out price. This works for simple and variable products and for variations, also when other products on the page or in the cart have a wholesale price. On the product page, a chosen variation with no wholesale price also shows only its regular price.

**New:** The product shows only its regular price: no "Wholesale Price:" line and no crossed-out price. This works for simple and variable products and for variations, also when other products on the page or in the cart have a wholesale price.

**Variation titles:**

- SV-430 (Shop page): The shop page shows only the regular price of a product with no wholesale price
- SV-431 (Product page): The product page shows only the regular price of a product, or of a chosen variation, with no wholesale price
- SV-425 (Cart page): The cart page shows only the regular price of a product with no wholesale price
- SV-427 (Checkout page): The checkout page shows only the regular price of a product with no wholesale price
- SV-994 (Mini cart): The mini cart shows only the regular price of a product with no wholesale price
- SV-995 (Grouped product page): The grouped product table shows only the regular price of a product with no wholesale price
- SV-996 (Product Collection block): The Product Collection block shows only the regular price of a product with no wholesale price

## F-7/S-987 The hide setting removes the crossed-out regular price range of a grouped product, and the wholesale price range still shows

**Old:** Example: a grouped product with a child at $150.00 (wholesale price $100.00) and a child at $80.00 (no wholesale price) shows only "Wholesale Price: $80.00 – $100.00". The table of child products on the product page shows each child price as the cart does (see F-5).

**New:** Example: a grouped product with a child at $150.00 (wholesale price $100.00) and a child at $80.00 (no wholesale price) shows only "Wholesale Price: $80.00 – $100.00". The child product table follows the cart prices of F-5.

**Variation titles:**

- SV-988 (Shop page): The shop page shows only the wholesale price range of a grouped product, with no crossed-out regular price range
- SV-989 (Product page): The product page shows only the wholesale price range of a grouped product, with no crossed-out regular price range, and the table of child products shows each child price as the cart does

## F-8/S-1255 A response with no option has no categories field and no metadata field

**Old:** The fields are missing, not empty. A variation response never has a categories field (WooCommerce does not give one).

**New:** The fields are missing, not empty.

**Variation titles:**

- SV-1256 (Get a product, Simple): A Get a product response with no option has no categories field and no metadata field for a simple product
- SV-1257 (Get a product, Variable): A Get a product response with no option has no categories field and no metadata field for a variable product
- SV-1258 (List products, Simple): A List products response with no option has no categories field and no metadata field for each simple product
- SV-1259 (Update a product, Simple): An Update a product response with no option has no categories field and no metadata field for the simple product
- SV-1260 (Get a variation, Variation): A Get a variation response with no option has no metadata field, and never has a categories field, because WooCommerce does not give one for a variation
- SV-1261 (List variations, Variation): A List variations response with no option has no metadata field, and never has a categories field, because WooCommerce does not give one for a variation
- SV-1262 (Create a variation, Variation): A Create a variation response with no option has no metadata field, and never has a categories field, because WooCommerce does not give one for a variation
- SV-1263 (Update a variation, Variation): An Update a variation response with no option has no metadata field, and never has a categories field, because WooCommerce does not give one for a variation

## F-9/S-1106 A shop manager can set the wholesale price, as an admin can

**Old:** The result is the same as for an admin: 201 on create, 200 on update, and the response shows the wholesale price.

**New:** The result is the same as for an admin.

**Variation titles:**

- SV-1107 (Create): Create: a shop manager gets status 201 and the wholesale price in the response, as an admin does
- SV-1108 (Update): Update: a shop manager gets status 200 and the wholesale price in the response, as an admin does

## F-9/S-1109 A user who cannot edit products is refused, and no product is made or changed

**Old:** On create, the error code is woocommerce_rest_cannot_create with the message "Sorry, you are not allowed to create resources." On update, it is woocommerce_rest_cannot_edit with "Sorry, you are not allowed to edit this resource." A logged-in user gets status 403, a guest gets 401.

**New:** WooCommerce refuses the request. On create, the message is "Sorry, you are not allowed to create resources." On update, it is "Sorry, you are not allowed to edit this resource."

**Variation titles:**

- SV-1110 (Create, Customer): Create: a regular customer gets status 403 with the error woocommerce_rest_cannot_create, and no product is made
- SV-1111 (Create, Wholesale customer): Create: a wholesale customer gets status 403 with the error woocommerce_rest_cannot_create, and no product is made
- SV-1112 (Create, Guest): Create: a guest gets status 401 with the error woocommerce_rest_cannot_create, and no product is made
- SV-1113 (Update, Customer): Update: a regular customer gets status 403 with the error woocommerce_rest_cannot_edit, and the product does not change
- SV-1114 (Update, Wholesale customer): Update: a wholesale customer gets status 403 with the error woocommerce_rest_cannot_edit, and the product does not change
- SV-1115 (Update, Guest): Update: a guest gets status 401 with the error woocommerce_rest_cannot_edit, and the product does not change

## F-10/S-1278 A user who cannot delete products is refused, and the product stays

**Old:** The error code is woocommerce_rest_cannot_delete, with the message "Sorry, you are not allowed to delete this resource.". A logged-in user gets error 403. A guest gets error 401.

**New:** The error code is woocommerce_rest_cannot_delete, with the message "Sorry, you are not allowed to delete this resource."

**Variation titles:**

- SV-1279 (Customer, 403): A regular customer gets error 403, and the product stays
- SV-1280 (Wholesale customer, 403): A wholesale customer gets error 403, and the product stays
- SV-1281 (Guest, 401): A guest gets error 401, and the product stays

## F-11/S-1117 List products: only the products with a wholesale price for the role are returned

**Old:** A variable product counts when at least one of its variations has a wholesale price for the role. Products with no wholesale price for the role are left out.

**New:** Products with no wholesale price for the role are left out.

**Variation titles:**

- SV-1118 (Simple product): List products: only the simple products with a wholesale price for the role are returned
- SV-1119 (Variable product): List products: only the variable products with at least one variation with a wholesale price for the role are returned
- SV-1120 (External product): List products: only the external products with a wholesale price for the role are returned

## F-15/S-1131 A shop manager can set the wholesale price, as an admin can

**Old:** The result is the same as for an admin: 201 on create, 200 on update, and the response shows the wholesale price.

**New:** The result is the same as for an admin: the response shows the wholesale price.

**Variation titles:**

- SV-1132 (Create): Create: a shop manager adds the variation with its wholesale price and gets status 201
- SV-1133 (Update): Update: a shop manager changes the wholesale price of the variation and gets status 200

## F-15/S-1134 A user who cannot edit products is refused, and no variation is made or changed

**Old:** On create, the error code is woocommerce_rest_cannot_create with the message "Sorry, you are not allowed to create resources." On update, it is woocommerce_rest_cannot_edit with "Sorry, you are not allowed to edit this resource." A logged-in user gets status 403, a guest gets 401.

**New:** Only a user who can create and edit products can add or change a variation.

**Variation titles:**

- SV-1135 (Create, Customer): Create: a regular customer gets error 403 woocommerce_rest_cannot_create "Sorry, you are not allowed to create resources.", and no variation is made
- SV-1136 (Create, Wholesale customer): Create: a wholesale customer gets error 403 woocommerce_rest_cannot_create "Sorry, you are not allowed to create resources.", and no variation is made
- SV-1137 (Create, Guest): Create: a guest gets error 401 woocommerce_rest_cannot_create "Sorry, you are not allowed to create resources.", and no variation is made
- SV-1138 (Update, Customer): Update: a regular customer gets error 403 woocommerce_rest_cannot_edit "Sorry, you are not allowed to edit this resource.", and the variation does not change
- SV-1139 (Update, Wholesale customer): Update: a wholesale customer gets error 403 woocommerce_rest_cannot_edit "Sorry, you are not allowed to edit this resource.", and the variation does not change
- SV-1140 (Update, Guest): Update: a guest gets error 401 woocommerce_rest_cannot_edit "Sorry, you are not allowed to edit this resource.", and the variation does not change

## F-28/S-334 Step 1 button opens the product page of the plugin

**Old:** The Order Form, Lead Capture and Quotes buttons open the page in a new tab. The Payments button opens it in the same tab.

**New:** Each Step 1 button opens the product page of its own plugin. Only the tab differs.

**Variation titles:**

- SV-883 (Wholesale Order Form): The Step 1 button on the Wholesale Order Form upsell page opens the product page of the plugin in a new tab
- SV-884 (Wholesale Lead Capture): The Step 1 button on the Wholesale Lead Capture upsell page opens the product page of the plugin in a new tab
- SV-885 (Wholesale Quotes): The Step 1 button on the Wholesale Quotes upsell page opens the product page of the plugin in a new tab
- SV-886 (Wholesale Payments): The Step 1 button on the Wholesale Payments upsell page opens the product page of the plugin in the same tab

## F-30/S-1343 A wholesale sale price typed in the field is not saved

**Old:** A click opens the upgrade popup, but the admin can reach the field with the Tab key and type. After "Update" (simple product) or "Save changes" (variation) and a page reload, the field is empty and the product has no wholesale sale price. The free plugin has no code that saves the sale dates either.

**New:** A click opens the upgrade popup, but the admin can reach the field with the Tab key and type. After the save and a page reload, the field is empty and the product has no wholesale sale price. The free plugin has no code that saves the sale dates either.

**Variation titles:**

- SV-1344 (Simple product): A wholesale sale price typed on a simple product is not saved after "Update" and a page reload
- SV-1345 (Variation): A wholesale sale price typed on a variation is not saved after "Save changes" and a page reload

## F-31/S-1348 The new name shows in the wholesale price fields of the admin product screens

**Old:** Product edit screen: the role heading in the "Wholesale Prices" section. Products list: the role name above the price in the "Wholesale Price" column.

**New:** The new role name shows in place of the old name.

**Variation titles:**

- SV-1349 (Product edit screen): The product edit screen shows the new name as the role heading in the "Wholesale Prices" section
- SV-1350 (Products list): The products list shows the new name above the price in the "Wholesale Price" column

## F-35/S-1164 Wholesale customer sees the products whose wholesale price is in the range on other product list pages

**Old:** The result is the same as on the classic shop page (S-404). The shop page of a block theme has no price filter by default: the range comes from the address. On the [products] shortcode page, non-wholesale customers get all products in every range, because WooCommerce does not filter the shortcode by price.

**New:** The result is the same as on the classic shop page (S-404).

**Variation titles:**

- SV-1165 (Product category page): Wholesale customer sees the products whose wholesale price is in the range on a product category page
- SV-1166 (Product search results): Wholesale customer sees the products whose wholesale price is in the range on the product search results
- SV-1167 (Shop page of a block theme): Wholesale customer sees the products whose wholesale price is in the range on the shop page of a block theme, which has no price filter by default and takes the range from the address
- SV-1168 ([products] shortcode page): Wholesale customer sees the products whose wholesale price is in the range on the [products] shortcode page, where non-wholesale customers get all products in every range

## F-36/S-1352 During a preview, the block cart, the checkout and the mini cart show the wholesale prices of the previewed role

**Old:** The block cart, the block checkout and the mini cart block show the regular price crossed out next to the wholesale price, and "Save" with the difference. The shortcode checkout shows only the wholesale price in the order table. The mini cart widget shows "1 × " with the crossed-out regular price, then "Wholesale Price:" and the wholesale price.

**New:** Each place shows the wholesale price of the previewed role, in its own layout.

**Variation titles:**

- SV-1353 (Cart page, Block): The cart block shows the crossed-out regular price, the wholesale price of the previewed role, and "Save" with the difference
- SV-1354 (Checkout page, Shortcode): The shortcode checkout page shows only the wholesale price of the previewed role in the order table
- SV-1355 (Checkout page, Block): The checkout block shows the crossed-out regular price, the wholesale price of the previewed role, and "Save" with the difference
- SV-1356 (Mini cart, Widget): The mini cart widget shows "1 × ", the crossed-out regular price, "Wholesale Price:" and the wholesale price of the previewed role
- SV-1357 (Mini cart, Block): The mini cart block shows the crossed-out regular price, the wholesale price of the previewed role, and "Save" with the difference

## F-47/S-1378 Wholesale customer sees the wholesale price of the copy on the product page after the admin publishes it

**Old:** The copy shows the same prices as the original, for example "Wholesale Price: $30.00" under the crossed-out regular price. For a variable product, the range shows under the name, and a chosen variation shows its own wholesale price.

**New:** The copy shows the same prices as the original, for example "Wholesale Price: $30.00".

**Variation titles:**

- SV-1379 (Simple product): Wholesale customer sees the "Wholesale Price:" line of a published simple product copy under the crossed-out regular price
- SV-1380 (Variable product): Wholesale customer sees the wholesale price range of a published variable product copy under its name, and the wholesale price of each chosen variation

## F-54/S-1395 A shop manager sees the install buttons, but a click installs and activates nothing

**Old:** About page: the button says "Installing...", then "Install Plugin" again, with no error text. Dashboard box, Install & Activate: the message "The plugin could not be installed or activated. Please try again." (the page has no install token for this user, so the server answers only "0"). Dashboard box, Activate: the message "You do not have permission to activate plugins."

**New:** Each button shows its own result, and no plugin is installed or activated. The "Install & Activate" button fails for a shop manager because the page has no install token for this user and the server answers only "0".

**Variation titles:**

- SV-1396 (About page, Install Plugin): For a shop manager, the "Install Plugin" button on the About page says "Installing...", then "Install Plugin" again, with no error text
- SV-1397 (Dashboard box, Install & Activate): For a shop manager, the "Install & Activate" button in the dashboard box shows "The plugin could not be installed or activated. Please try again."
- SV-1398 (Dashboard box, Activate): For a shop manager, the "Activate" button in the dashboard box shows "You do not have permission to activate plugins."

## F-59/S-1535 The "Percentage" discount type shows the "Signup Fee Discount (%)" field and locks the wholesale sign-up fee

**Old:** From the code: the field label is "Signup Fee Discount (%)", with the tooltip "The percentage amount discounted from the Sign-up fee". With "Fixed", the field hides and the "Wholesale Signup Fee" field can be edited again. For a simple subscription the code may not do this step: see the open question.

**New:** From the code: the field label is "Signup Fee Discount (%)", with the tooltip "The percentage amount discounted from the Sign-up fee". For a simple subscription, "Fixed" may not hide the field and unlock the fee again: see the open question.

**Variation titles:**

- SV-1536 (Simple subscription): On a simple subscription, "Percentage" shows the "Signup Fee Discount (%)" field and locks the wholesale sign-up fee
- SV-1537 (Variation of a variable subscription): On a variation of a variable subscription, "Percentage" shows the "Signup Fee Discount (%)" field and locks the wholesale sign-up fee, and "Fixed" hides the field and unlocks the fee again

## F-59/S-1538 With "Percentage", the wholesale sign-up fee is the sign-up fee minus the discount

**Old:** From the code: the editor fills the fee at once when the admin types in the discount field. Example: sign-up fee 30 and discount 20 give 24. The result has the shop's price decimals. A 100% discount gives 0. An empty or 0 discount empties the fee. On a variation, a new sign-up fee also fills the fee again. On a simple subscription, a new "Sign-up fee" may not do this: see the open question.

**New:** From the code: the editor fills the fee at once when the admin types in the discount field. Example: sign-up fee 30 and discount 20 give 24. The result has the shop's price decimals. A 100% discount gives 0. An empty or 0 discount empties the fee. For a simple subscription, a new "Sign-up fee" may not fill the fee again: see the open question.

**Variation titles:**

- SV-1539 (Simple subscription): On a simple subscription, the wholesale sign-up fee is the sign-up fee minus the discount
- SV-1540 (Variation of a variable subscription): On a variation of a variable subscription, the wholesale sign-up fee is the sign-up fee minus the discount, and a new sign-up fee fills the fee again

## F-59/S-1541 A sign-up fee discount below 0 or above 100 shows an error message

**Old:** From the code: while the admin types, a value above 100 shows "Please enter in a value not greater than 100 percent." and a value below 0 shows "Please enter in a value not less than 0 percent". On a variation, when the admin leaves the field, the editor also empties the discount and the wholesale sign-up fee. On a simple subscription this last step may not happen: see the open question.

**New:** From the code: while the admin types, a value above 100 shows "Please enter in a value not greater than 100 percent." and a value below 0 shows "Please enter in a value not less than 0 percent". For a simple subscription, the editor may not empty the discount and the fee when the admin leaves the field: see the open question.

**Variation titles:**

- SV-1542 (Simple subscription): On a simple subscription, a sign-up fee discount below 0 or above 100 shows an error message
- SV-1543 (Variation of a variable subscription): On a variation of a variable subscription, a sign-up fee discount below 0 or above 100 shows an error message, and the editor empties the discount and the fee when the admin leaves the field

## F-64/S-1561 Wholesale customer sees the wholesale price in the selected currency on the shop page and the product page

**Old:** From the code: when the selected currency is not the store currency, the plugin passes each wholesale price to WooCommerce Multilingual (filter "wcml_formatted_price") to get the price text. A price range passes the lowest and the highest price.

**New:** From the code: when the selected currency is not the store currency, the plugin passes each wholesale price to WooCommerce Multilingual (filter "wcml_formatted_price") to get the price text.

**Variation titles:**

- SV-1562 (Simple product): Wholesale customer sees the wholesale price of a simple product in the selected currency on the shop page and the product page
- SV-1563 (Variable product (price range)): Wholesale customer sees the wholesale price range of a variable product in the selected currency on the shop page and the product page, with the lowest and the highest price in that currency
- SV-1564 (Variation chosen on the product page): Wholesale customer sees the wholesale price of a chosen variation in the selected currency on the product page
- SV-1565 (Grouped product (price range)): Wholesale customer sees the wholesale price range of a grouped product in the selected currency on the shop page and the product page, with the lowest and the highest price in that currency

## F-68/S-748 Update: an ID that does not exist gives the error "Invalid ID." for that item only

**Old:** The item shows its id, status 400 and the error code woocommerce_rest_product_invalid_id (products batch) or woocommerce_rest_product_variation_invalid_id (variations batch). The other items are saved.

**New:** The item shows its id and status 400. The other items are saved.

**Variation titles:**

- SV-1188 (Products batch): Update: in the products batch, an ID that does not exist gives the error "Invalid ID." with the code woocommerce_rest_product_invalid_id for that item only
- SV-1189 (Variations batch): Update: in the variations batch, an ID that does not exist gives the error "Invalid ID." with the code woocommerce_rest_product_variation_invalid_id for that item only

## F-68/S-749 Delete: each item is deleted permanently, and the response shows its wholesale prices

**Old:** The request needs no force option. On the products batch, force=0 in the request URL moves each product to the trash instead. The variations batch always deletes permanently, also with force=0.

**New:** The request needs no force option to delete permanently.

**Variation titles:**

- SV-750 (Products batch): Delete: the products batch deletes each product permanently and shows its wholesale prices, but force=0 in the request URL moves each product to the trash
- SV-751 (Variations batch): Delete: the variations batch deletes each variation permanently and shows its wholesale prices, also with force=0

## F-68/S-1190 Delete: an ID that does not exist gives the error "Invalid ID." for that item only

**Old:** The item shows its id, status 404 and the error code woocommerce_rest_product_invalid_id (products batch) or woocommerce_rest_product_variation_invalid_id (variations batch). The other items are deleted.

**New:** The item shows its id and status 404. The other items are deleted.

**Variation titles:**

- SV-1191 (Products batch): Delete: in the products batch, an ID that does not exist gives the error "Invalid ID." with the code woocommerce_rest_product_invalid_id for that item only
- SV-1192 (Variations batch): Delete: in the variations batch, an ID that does not exist gives the error "Invalid ID." with the code woocommerce_rest_product_variation_invalid_id for that item only

## F-68/S-1199 A user who cannot edit products is refused, and no item is made, changed or deleted

**Old:** The whole request is refused. The error code is woocommerce_rest_cannot_batch with the message "Sorry, you are not allowed to batch manipulate this resource." A guest gets status 401. A logged-in customer or wholesale customer gets status 403.

**New:** The whole request is refused. The error code is woocommerce_rest_cannot_batch with the message "Sorry, you are not allowed to batch manipulate this resource."

**Variation titles:**

- SV-1200 (Products batch, Customer): The products batch refuses a regular customer with status 403, and no product is made, changed or deleted
- SV-1201 (Products batch, Wholesale customer): The products batch refuses a wholesale customer with status 403, and no product is made, changed or deleted
- SV-1202 (Products batch, Guest): The products batch refuses a guest with status 401, and no product is made, changed or deleted
- SV-1203 (Variations batch, Customer): The variations batch refuses a regular customer with status 403, and no variation is made, changed or deleted
- SV-1204 (Variations batch, Wholesale customer): The variations batch refuses a wholesale customer with status 403, and no variation is made, changed or deleted
- SV-1205 (Variations batch, Guest): The variations batch refuses a guest with status 401, and no variation is made, changed or deleted

## F-69/S-1429 A user who cannot delete products is refused, and the variation stays

**Old:** The error code is woocommerce_rest_cannot_delete, with the message "Sorry, you are not allowed to delete this resource.". A logged-in user gets error 403. A guest gets error 401.

**New:** The error code is woocommerce_rest_cannot_delete, with the message "Sorry, you are not allowed to delete this resource."

**Variation titles:**

- SV-1430 (Customer, 403): The API refuses a regular customer with error 403, and the variation stays
- SV-1431 (Wholesale customer, 403): The API refuses a wholesale customer with error 403, and the variation stays
- SV-1432 (Guest, 401): The API refuses a guest with error 401, and the variation stays

## F-83/S-854 The page shows the free-version notice bar at the top

**Old:** The bar says "You're using Wholesale Prices by Wholesale Suite free version. To unlock more features consider upgrading to Premium." On Dashboard and Settings, the bar is in the page, but the WooCommerce page header covers it, so an admin does not see it.

**New:** The bar says "You're using Wholesale Prices by Wholesale Suite free version. To unlock more features consider upgrading to Premium."

**Variation titles:**

- SV-855 (Wholesale > Dashboard): The Wholesale Dashboard page has the free-version notice bar at the top, but the WooCommerce page header covers it, so the admin does not see it
- SV-856 (Wholesale > Settings): The Wholesale Settings page has the free-version notice bar at the top, but the WooCommerce page header covers it, so the admin does not see it
- SV-857 (Wholesale > About): The Wholesale About page has the free-version notice bar at the top, and the admin sees it
- SV-858 (Wholesale > Help): The Wholesale Help page has the free-version notice bar at the top, and the admin sees it

## F-87/S-913 A click on a locked tax field, or a choice in a locked tax list, opens the upgrade popup

**Old:** A click on the "Tax Exemption" checkbox or in a suffix field opens the popup. A click on a display list only opens the list; the popup opens when you choose "Including tax (Premium)" or "Excluding tax (Premium)". "Tax Exemption" opens the tax exemption popup, the two display lists open the tax display popup, and the two suffix fields open the suffix popup. The X button or the Escape key closes the popup.

**New:** The X button or the Escape key closes the popup.

**Variation titles:**

- SV-914 (Tax Exemption): The "Tax Exemption" checkbox opens the tax exemption popup when you click it
- SV-915 (Display Prices in the Shop): The "Display Prices in the Shop" list opens the tax display popup when you choose "Including tax (Premium)" or "Excluding tax (Premium)", not when you click the list
- SV-916 (Display Prices During Cart and Checkout): The "Display Prices During Cart and Checkout" list opens the tax display popup when you choose "Including tax (Premium)" or "Excluding tax (Premium)", not when you click the list
- SV-917 (Override Regular Price Suffix): The "Override Regular Price Suffix" field opens the suffix popup when you click it
- SV-918 (Wholesale Price Suffix): The "Wholesale Price Suffix" field opens the suffix popup when you click it

## F-88/S-925 The "Learn more" button of an inactive plugin opens the page of that plugin in a new tab

**Old:** Each plugin box shows the link as blue underlined text, not as a button. Labels and pages on wholesalesuiteplugin.com: Wholesale Prices Premium: "Learn more about Prices Premium", /woocommerce-wholesale-prices-premium/. Wholesale Order Form: "Learn more about Order Form", /woocommerce-wholesale-order-form/. Wholesale Lead Capture: "Learn more about Lead Capture", /woocommerce-wholesale-lead-capture/. Wholesale Payments: "Learn more about Wholesale Payments", /woocommerce-wholesale-payments/. Each link has tracking values (utm_source=wwp, utm_medium=upsell).

**New:** Each plugin box shows the link as blue underlined text, not as a button. Each link has tracking values (utm_source=wwp, utm_medium=upsell).

**Variation titles:**

- SV-926 (Wholesale Prices Premium): The "Learn more about Prices Premium" link opens the /woocommerce-wholesale-prices-premium/ page on wholesalesuiteplugin.com in a new tab
- SV-927 (Wholesale Order Form): The "Learn more about Order Form" link opens the /woocommerce-wholesale-order-form/ page on wholesalesuiteplugin.com in a new tab
- SV-928 (Wholesale Lead Capture): The "Learn more about Lead Capture" link opens the /woocommerce-wholesale-lead-capture/ page on wholesalesuiteplugin.com in a new tab
- SV-929 (Wholesale Payments): The "Learn more about Wholesale Payments" link opens the /woocommerce-wholesale-payments/ page on wholesalesuiteplugin.com in a new tab

## F-95/S-1224 A key without the permission for the request method gets an error on a wholesale API route

**Old:** The reply has status 401, and the route does not run. A "Read" key on a write request (POST, PUT, PATCH or DELETE) gets "The API key provided does not have write permissions.". A "Write" key on a read request (GET or HEAD) gets "The API key provided does not have read permissions.".

**New:** The reply has status 401, and the route does not run.

**Variation titles:**

- SV-1225 (Read, Write request): A "Read" key on a write request (POST, PUT, PATCH or DELETE) gets the error "The API key provided does not have write permissions."
- SV-1226 (Write, Read request): A "Write" key on a read request (GET or HEAD) gets the error "The API key provided does not have read permissions."

## F-97/S-966 A set text shows before the regular price, and the regular price is not crossed out

**Old:** From the code: the text and the regular price show on one line above the wholesale price line, for example "Retail Price: $50.00" and under it "Wholesale Price: $40.00". The plugin turns off the line through the regular price on this line. The text shows as it is set: the plugin adds no colon. A variable product shows the text before the regular price range, for example "Retail Price: $40.00 – $55.00". On the grouped product page, each child row of the table shows the text before its own regular price.

**New:** From the code: the text and the regular price show on one line above the wholesale price line, for example "Retail Price: $50.00" and under it "Wholesale Price: $40.00". The plugin turns off the line through the regular price on this line. The text shows as it is set: the plugin adds no colon. A variable product shows a range, for example "Retail Price: $40.00 – $55.00".

**Variation titles:**

- SV-1623 (Shop page, Simple product): The shop page shows the text before the regular price of a simple product, not crossed out
- SV-1624 (Product page, Simple product): The product page shows the text before the regular price of a simple product, not crossed out
- SV-1625 (Shop page, Variable product): The shop page shows the text before the regular price range of a variable product, not crossed out
- SV-1626 (Product page, Variable product): The product page shows the text before the regular price range of a variable product, not crossed out
- SV-1627 (Product page, Variation): The product page shows the text before the regular price of the chosen variation, not crossed out
- SV-1628 (Grouped product page, Simple product): The grouped product page shows the text before the regular price in each child product row of the table, not crossed out
- SV-1629 (Product Collection block, Simple product): The Product Collection block shows the text before the regular price of a simple product, not crossed out
- SV-1630 (Product Collection block, Variable product): The Product Collection block shows the text before the regular price range of a variable product, not crossed out

## F-103/S-1676 With Premium active, the product editor shows no "Add additional wholesale price levels" link

**Old:** From the code: the "Wholesale Prices" section shows only the text "Set a wholesale price for this product." Without Premium, a link follows it: "Add additional wholesale price levels." on a simple product, and "Add additional wholesale price levels" (no full stop) on a variation.

**New:** From the code: the "Wholesale Prices" section shows only the text "Set a wholesale price for this product." Without Premium, the link follows this text.

**Variation titles:**

- SV-1677 (Simple product): With Premium active, the product editor shows no "Add additional wholesale price levels." link on a simple product
- SV-1678 (Variation): With Premium active, the product editor shows no "Add additional wholesale price levels" link on a variation

## F-104/S-1688 The customer list ability reports the filtered role for a customer with two wholesale roles

**Old:** From the code: with the role filter bronze, the customer's wholesale_role is bronze. With no role filter, the list has the customers of all wholesale roles, and wholesale_role is the first wholesale role of the account, for example wholesale_customer. The customer shows one time in the list.

**New:** From the code: the customer shows one time in the list.

**Variation titles:**

- SV-1689 (bronze): With the role filter bronze, the customer list ability reports bronze as the wholesale role of the customer
- SV-1690 (None): With no role filter, the customer list ability lists the customers of all wholesale roles and reports the first wholesale role of the account, for example wholesale_customer

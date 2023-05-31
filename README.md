SHOPIFY_API_KEY:              YOUR_API_KEY
SHOPIFY_API_SECRET:           YOUR_API_SECRET
SHOPIFY_API_VERSION:          2023-04
SHOPIFY_API_SCOPES:           read_orders,write_customers

// These need to be the same as the payment app's.
SHOPIFY_MYSQL_HOST:           YOUR_DOMAIN
SHOPIFY_MYSQL_USER:           YOUR_USER
SHOPIFY_MYSQL_PASSWORD:       YOUR_PASSWORD
SHOPIFY_MYSQL_DATABASE:       YOUR_DB_NAME

SHOPIFY_EXT_ID:               COPIED_VALUE_FROM_.env (.env gets created after running `npm run deploy -- --reset`)


```
CREATE TABLE shops ( _id VARCHAR(500) NOT NULL PRIMARY KEY, data JSON NOT NULL, created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL );

```

```
npm install

npm run deploy -- --reset (choose your paryner account and target app as an exsiting one)

npm run build (required for /frontend React first running and code update, note that you need set `SHOPIFY_API_KEY` and `SHOPIFY_EXT_ID` evironmental variables before running this build)

npm run start

```

* Member registration page and badge use [Shopify App proxies](https://shopify.dev/docs/apps/online-store/app-proxies) and you need to dispatch `YOUR_APP_SERVER_URL/appproxy` (Proxy URL) to `STORE_URL/apps/b2b` following [this step](https://shopify.dev/docs/apps/online-store/app-proxies#add-an-app-proxy). Note that the app proxy doesn't accept ngrol bypass URL, so you need a real public one.



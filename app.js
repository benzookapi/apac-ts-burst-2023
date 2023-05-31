'use strict';

const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const koaRequest = require('koa-http-request');
const views = require('koa-views');
const serve = require('koa-static');

const crypto = require('crypto');

const mysql = require('mysql');

const jwt_decode = require('jwt-decode'); // For client side JWT with no signature validation

const router = new Router();
const app = module.exports = new Koa();

app.use(bodyParser());

app.use(koaRequest({

}));

app.use(views(__dirname + '/views', {
  map: {
    html: 'underscore'
  }
}));

app.use(serve(__dirname + '/public'));

// Shopify API info.
const API_KEY = `${process.env.SHOPIFY_API_KEY}`;
const API_SECRET = `${process.env.SHOPIFY_API_SECRET}`;
const API_VERSION = `${process.env.SHOPIFY_API_VERSION}`;
const API_SCOPES = `${process.env.SHOPIFY_API_SCOPES}`;

const CONTENT_TYPE_JSON = 'application/json';
const CONTENT_TYPE_FORM = 'application/x-www-form-urlencoded';

const GRAPHQL_PATH_ADMIN = `admin/api/${API_VERSION}/graphql.json`;

const UNDEFINED = 'undefined';

// Admin path signature secret
const HMAC_SECRET = API_SECRET;

// MySQL Settings
const MYSQL_HOST = `${process.env.SHOPIFY_MYSQL_HOST}`;
const MYSQL_USER = `${process.env.SHOPIFY_MYSQL_USER}`;
const MYSQL_PASSWORD = `${process.env.SHOPIFY_MYSQL_PASSWORD}`;
const MYSQL_DATABASE = `${process.env.SHOPIFY_MYSQL_DATABASE}`;
const MYSQL_TABLE = 'shops';

router.get('/', async (ctx, next) => {
  console.log("+++++++++++++++ / +++++++++++++++");
  if (!checkSignature(ctx.request.query)) {
    ctx.status = 400;
    return;
  }

  const shop = ctx.request.query.shop;

  let shop_data = null;
  let api_res = null;
  try {
    shop_data = await (getDB(shop));
    let install = false;
    if (shop_data == null) {
      console.log("No shop data");
      install = true;
    } else {
      try {
        api_res = await (callGraphql(ctx, shop, `{
        shop {
          name
        }
        app {
          handle
         }
      }`, null, GRAPHQL_PATH_ADMIN, null));
      } catch (e) { }
      if (api_res == null || typeof api_res.data.shop.name === UNDEFINED) {
        console.log("The stored access token is invalid");
        install = true;
      }
    }
    if (install) {
      const redirectUrl = `https://${shop}/admin/oauth/authorize?client_id=${API_KEY}&scope=${API_SCOPES}&redirect_uri=https://${ctx.request.host}/callback&state=&grant_options[]=`;
      console.log(`Redirecting to ${redirectUrl} for OAuth flow...`);
      ctx.redirect(redirectUrl);
      return;
    }
  } catch (e) {
    ctx.status = 500;
    return;
  }

  setContentSecurityPolicy(ctx, shop);
  await ctx.render('index', {});

});

router.get('/callback', async (ctx, next) => {
  console.log("+++++++++++++++ /callback +++++++++++++++");
  if (!checkSignature(ctx.request.query)) {
    ctx.status = 400;
    return;
  }
  let req = {};
  req.client_id = API_KEY;
  req.client_secret = API_SECRET;
  req.code = ctx.request.query.code;

  const shop = ctx.request.query.shop;

  let res = null;
  try {
    res = await (accessEndpoint(ctx, `https://${shop}/admin/oauth/access_token`, req, null, CONTENT_TYPE_FORM));
    if (typeof res.access_token === UNDEFINED) {
      ctx.status = 500;
      return;
    }
  } catch (e) {
    ctx.status = 500;
    return;
  }

  getDB(shop).then(function (shop_data) {
    if (shop_data == null) {
      insertDB(shop, res).then(function (r) { }).catch(function (e) { });
    } else {
      setDB(shop, res).then(function (r) { }).catch(function (e) { });
    }
  }).catch(function (e) {
    ctx.status = 500;
    return;
  });

  let api_res = null;
  try {
    api_res = await (callGraphql(ctx, shop, `{
        app {
          handle
         }
      }`, res.access_token, GRAPHQL_PATH_ADMIN, null));
  } catch (e) { }

  try {
    await (callGraphql(ctx, shop, `mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        userErrors {
          field
          message
        }
        webhookSubscription {
          id
          endpoint
          format
          includeFields
          topic
        }
      }
    }`, res.access_token, GRAPHQL_PATH_ADMIN, {
      "topic": "ORDERS_FULFILLED",
      "webhookSubscription": {
        "callbackUrl": `https://${ctx.request.host}/webhookshipping`,
        "format": "JSON"
      }
    }));
  } catch (e) {
    console.log(`${e}`);
  }

  ctx.redirect(`https://${getAdminFromShop(shop)}/apps/${api_res.data.app.handle}`);

});

router.get('/index', async (ctx, next) => {
  console.log("+++++++++++++++ /index +++++++++++++++");
  console.log('Authenticated fetch');
  const token = getTokenFromAuthHeader(ctx);
  if (!checkAuthFetchToken(token)[0]) {
    ctx.body.result.message = "Signature unmatched. Incorrect authentication bearer sent";
    ctx.status = 400;
    return;
  }

  ctx.set('Content-Type', 'application/json');
  ctx.body = {
    "result": {
      "message": "",
      "response": {}
    }
  };

  const shop = getShopFromAuthToken(token);
  let shop_data_gateway = {};
  try {
    shop_data_gateway = await (getDB(shop, MYSQL_TABLE_GATEWAY));
  } catch (e) {
    ctx.body.result.message = "Internal error in retrieving shop data";
    ctx.status = 500;
    return;
  }

  ctx.body.result.response = shop_data_gateway;
  ctx.status = 200;

});

/* --- App proxies endpoint --- */
router.get('/appproxy', async (ctx, next) => {
  console.log("+++++++++++++++ /appproxy +++++++++++++++");
  console.log(`request query: ${JSON.stringify(ctx.request.query, null, 4)}`);
  console.log(`request body: ${JSON.stringify(ctx.request.body, null, 4)}`);

  if (!checkAppProxySignature(ctx.request.query)) {
    ctx.status = 400;
    return;
  }

  const shop = ctx.request.query.shop;

  const customer_id = ctx.request.query.logged_in_customer_id;

  const action = typeof ctx.request.query.action !== UNDEFINED ? ctx.request.query.action : '';

  let api_res = null;
  if (customer_id !== '') {
    try {
      api_res = await callGraphql(ctx, shop, `{
      customer(id: "gid://shopify/Customer/${customer_id}") {
        email
        firstName
        lastName
        phone
        addresses(first: 10) {
          city
          address1
          address2
          company
          countryCode
          firstName
          lastName
          phone
          provinceCode
          zip
        }
        companyContactProfiles {
          company {
            id
            name
            contactRoles(first: 10, reverse:true) {
              nodes {
                id
                name
              }
            }
            contacts(first: 10, reverse:true) {
              nodes {
                id
                title
              }
            }
            locationCount
            locations(first: 10, reverse:true) {
              nodes {
                id
                shippingAddress {
                  address1
                  address2
                  city
                  countryCode
                  recipient
                  zip
                  zoneCode
                  phone                 
                }
                billingAddress {
                  address1
                  address2
                  city
                  countryCode
                  recipient
                  zip
                  zoneCode
                  phone
                }
              }
            }
          }
        }
      }
    }`, null, GRAPHQL_PATH_ADMIN, null);
    } catch (e) {
      console.log(`${e}`);
      // If an error occurs, Retry without B2B data for non-Plus stores.
      try {
        api_res = await callGraphql(ctx, shop, `{
        customer(id: "gid://shopify/Customer/${customer_id}") {
          email
          firstName
          lastName
          phone
          addresses(first: 10) {
            city
            address1
            address2
            company
            countryCode
            firstName
            lastName
            phone
            provinceCode
            zip
          }          
        }
      }`, null, GRAPHQL_PATH_ADMIN, null);
      } catch (e) {
        console.log(`${e}`);
      }
    }
  }

  const memberData = {};
  if (action === 'register' || action === 'submit') {
    if (customer_id === '' || api_res == null) {
      ctx.status = 400;
      return;
    }
    memberData.b2bMemberId = typeof ctx.request.query.b2bMemberId !== UNDEFINED ? ctx.request.query.b2bMemberId : `M${createUniqueId()}`;
    memberData.email = api_res.data.customer.email;
    memberData.companyName = typeof ctx.request.query.companyName !== UNDEFINED ? ctx.request.query.companyName : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 ? api_res.data.customer.companyContactProfiles[0].company.name : '';
    memberData.companyNameKana = typeof ctx.request.query.companyNameKana !== UNDEFINED ? ctx.request.query.companyNameKana : '';
    memberData.representativeSei = typeof ctx.request.query.representativeSei !== UNDEFINED ? ctx.request.query.representativeSei : '';
    memberData.representativeMei = typeof ctx.request.query.representativeMei !== UNDEFINED ? ctx.request.query.representativeMei : '';
    memberData.representativeSeiKana = typeof ctx.request.query.representativeSeiKana !== UNDEFINED ? ctx.request.query.representativeSeiKana : '';
    memberData.representativeMeiKana = typeof ctx.request.query.representativeMeiKana !== UNDEFINED ? ctx.request.query.representativeMeiKana : '';
    memberData.zipCode = typeof ctx.request.query.zipCode !== UNDEFINED ? ctx.request.query.zipCode : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress.zip : '';
    memberData.prefecture = typeof ctx.request.query.prefecture !== UNDEFINED ? ctx.request.query.prefecture : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress != null ? convertStateCodeToName(api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress.zoneCode) : '';
    memberData.address1 = typeof ctx.request.query.address1 !== UNDEFINED ? ctx.request.query.address1 : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress.city : '';
    memberData.address2 = typeof ctx.request.query.address2 !== UNDEFINED ? ctx.request.query.address2 : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress.address1 : '';
    memberData.address3 = typeof ctx.request.query.address3 !== UNDEFINED ? ctx.request.query.address3 : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress.address2 : '';
    memberData.auxName = typeof ctx.request.query.auxName !== UNDEFINED ? ctx.request.query.auxName : '';
    memberData.clerkSei = typeof ctx.request.query.clerkSei !== UNDEFINED ? ctx.request.query.clerkSei : api_res.data.customer.lastName != null ? api_res.data.customer.lastName : '';
    memberData.clerkMei = typeof ctx.request.query.clerkMei !== UNDEFINED ? ctx.request.query.clerkMei : api_res.data.customer.firstName != null ? api_res.data.customer.firstName : '';
    memberData.clerkSeiKana = typeof ctx.request.query.clerkSeiKana !== UNDEFINED ? ctx.request.query.clerkSeiKana : '';
    memberData.clerkMeiKana = typeof ctx.request.query.clerkMeiKana !== UNDEFINED ? ctx.request.query.clerkMeiKana : '';
    memberData.tel = typeof ctx.request.query.tel !== UNDEFINED ? ctx.request.query.tel : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress != null ? convertPhoneToLocal(api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].billingAddress.phone) : '';
    memberData.fax = typeof ctx.request.query.fax !== UNDEFINED ? ctx.request.query.fax : '';
    memberData.mobileTel = typeof ctx.request.query.mobileTel !== UNDEFINED ? ctx.request.query.mobileTel : '';
    memberData.url1 = typeof ctx.request.query.url1 !== UNDEFINED ? ctx.request.query.url1 : '';
    memberData.url2 = typeof ctx.request.query.url2 !== UNDEFINED ? ctx.request.query.url2 : '';
    memberData.url3 = typeof ctx.request.query.url3 !== UNDEFINED ? ctx.request.query.url3 : '';
    memberData.closingDay = typeof ctx.request.query.closingDay !== UNDEFINED ? ctx.request.query.closingDay : '31';
    memberData.paymentMethod = typeof ctx.request.query.paymentMethod !== UNDEFINED ? ctx.request.query.paymentMethod : '1';
    memberData.frdKey = typeof ctx.request.query.frdKey !== UNDEFINED ? ctx.request.query.frdKey : '';
    memberData.recipientData = {};
    memberData.recipientData.companyName = typeof ctx.request.query.recipientData_companyName !== UNDEFINED ? ctx.request.query.recipientData_companyName : '';
    memberData.recipientData.ompanyNameKana = typeof ctx.request.query.recipientData_companyNameKana !== UNDEFINED ? ctx.request.query.recipientData_companyNameKana : '';
    memberData.recipientData.representativeSei = typeof ctx.request.query.recipientData_representativeSei !== UNDEFINED ? ctx.request.query.recipientData_representativeSei : '';
    memberData.recipientData.representativeMei = typeof ctx.request.query.recipientData_representativeMei !== UNDEFINED ? ctx.request.query.recipientData_representativeMei : '';
    memberData.recipientData.representativeSeiKana = typeof ctx.request.query.recipientData_representativeSeiKana !== UNDEFINED ? ctx.request.query.recipientData_representativeSeiKana : '';
    memberData.recipientData.representativeMeiKana = typeof ctx.request.query.recipientData_representativeMeiKana !== UNDEFINED ? ctx.request.query.recipientData_representativeMeiKana : '';
    memberData.recipientData.zipCode = typeof ctx.request.query.recipientData_zipCode !== UNDEFINED ? ctx.request.query.recipientData_zipCode : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress.zip : '';
    memberData.recipientData.prefecture = typeof ctx.request.query.recipientData_prefecture !== UNDEFINED ? ctx.request.query.recipientData_prefecture : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress != null ? convertStateCodeToName(api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress.zoneCode) : '';
    memberData.recipientData.address1 = typeof ctx.request.query.recipientData_address1 !== UNDEFINED ? ctx.request.query.recipientData_address1 : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress.city : '';
    memberData.recipientData.address2 = typeof ctx.request.query.recipientData_address2 !== UNDEFINED ? ctx.request.query.recipientData_address2 : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress.address1 : '';
    memberData.recipientData.address3 = typeof ctx.request.query.recipientData_address3 !== UNDEFINED ? ctx.request.query.recipientData_address3 : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress != null ? api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress.address2 : '';
    memberData.recipientData.tel = typeof ctx.request.query.recipientData_tel !== UNDEFINED ? ctx.request.query.recipientData_tel : typeof api_res.data.customer.companyContactProfiles !== UNDEFINED && api_res.data.customer.companyContactProfiles.length > 0 && api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress != null ? convertPhoneToLocal(api_res.data.customer.companyContactProfiles[0].company.locations.nodes[0].shippingAddress.phone) : '';
    memberData.recipientData.fax = typeof ctx.request.query.recipientData_fax !== UNDEFINED ? ctx.request.query.recipientData_fax : '';
    memberData.recipientData.mobileTel = typeof ctx.request.query.recipientData_mobileTel !== UNDEFINED ? ctx.request.query.recipientData_mobileTel : '';
  }

  // Show the initial page for registration.
  if (action === 'register') {
    return await ctx.render('register', {
      app_url: `https://${ctx.request.host}`,
      shop_url: `https://${shop}`,
      logout_url: `https://${shop}/customer_identity/logout`,
      memberData: memberData,
      status: null
    });
  }
  // Submit the resigration data.
  if (action === 'submit') {
    const status = {};
    try {
      await callGraphql(ctx, shop, `mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            addresses(first: 1) {
              id
            }
          }
          userErrors {
            field
            message
          }
        }
      }`, null, GRAPHQL_PATH_ADMIN, {
        "input": {
          "id": `gid://shopify/Customer/${customer_id}`,
          "firstName": `${memberData.clerkMei}`,
          "lastName": `${memberData.clerkSei}`,
          "phone": `${memberData.tel}`,
          "addresses": [
            {
              "city": `${memberData.address1}`,
              "address1": `${memberData.address2}`,
              "address2": `${memberData.address3}`,
              "company": `${memberData.companyName}`,
              "countryCode": "JP",
              "firstName": `${memberData.clerkMei}`,
              "lastName": `${memberData.clerkSei}`,
              "phone": `${memberData.tel}`,
              "provinceCode": `${getProvinceCodeFromText(memberData.prefecture)}`,
              "zip": `${memberData.zipCode}`
            }
          ]
        }
      });
      // 3. Shopify company creation or update. (For Plus B2B feature only)
      if (typeof api_res.data.customer.companyContactProfiles !== UNDEFINED) {
        const location_data = {
          "billingAddress": {
            "address1": `${memberData.address2}`,
            "address2": `${memberData.address3}`,
            "city": `${memberData.address1}`,
            "countryCode": "JP",
            "recipient": `${memberData.clerkSei} ${memberData.clerkMei}`,
            "zip": `${memberData.zipCode}`,
            "zoneCode": `${getProvinceCodeFromText(memberData.prefecture)}`,
            "phone": `${memberData.tel}`,
          },
          "externalId": `${memberData.b2bMemberId}`,
          "name": `${memberData.companyName}`,
          "note": `${memberData.representativeSei} ${memberData.representativeMei} 担当者：${memberData.clerkSei} ${memberData.clerkMei}`,
          "phone": `${memberData.tel}`,
          "shippingAddress": {
            "address1": `${memberData.recipientData.address2 === '' ? memberData.address2 : memberData.recipientData.address2}`,
            "address2": `${memberData.recipientData.address3 === '' ? memberData.address3 : memberData.recipientData.address3} ${PAID_MEMBER_ID_TXT}${memberData.b2bMemberId}`,
            "city": `${memberData.recipientData.address1 === '' ? memberData.address1 : memberData.recipientData.address1}`,
            "countryCode": "JP",
            "recipient": `${memberData.recipientData.representativeSei} ${memberData.recipientData.representativeMei}`,
            "zip": `${memberData.recipientData.zipCode === '' ? memberData.zipCode : memberData.recipientData.zipCode}`,
            "zoneCode": `${getProvinceCodeFromText(memberData.recipientData.prefecture === '' ? memberData.prefecture : memberData.recipientData.prefecture)}`,
            "phone": `${memberData.recipientData.tel === '' ? memberData.tel : memberData.recipientData.tel}`,
          }
        };
        if (api_res.data.customer.companyContactProfiles.length > 0) {
          // 3-1. Update the current company which the current customer belongs to with a new location.
          api_res.data.customer.companyContactProfiles.map((p) => {
            callGraphql(ctx, shop, `mutation companyLocationCreate($companyId: ID!, $input: CompanyLocationInput!) {
            companyLocationCreate(companyId: $companyId, input: $input) {
              companyLocation {
                id
              }
              userErrors {
                field
                message
              }
            }
          }`, null, GRAPHQL_PATH_ADMIN, {
              "companyId": p.company.id,
              "input": location_data
            }).then((r) => {
              callGraphql(ctx, shop, `mutation companyLocationAssignRoles($companyLocationId: ID!, $rolesToAssign: [CompanyLocationRoleAssign!]!) {
                companyLocationAssignRoles(companyLocationId: $companyLocationId, rolesToAssign: $rolesToAssign) {
                  roleAssignments {
                   id
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }`, null, GRAPHQL_PATH_ADMIN, {
                "companyLocationId": r.data.companyLocationCreate.companyLocation.id,
                "rolesToAssign": [
                  {
                    "companyContactId": p.company.contacts.nodes[0].id,
                    "companyContactRoleId": p.company.contactRoles.nodes[0].id
                  }
                ]
              });
            });
          });
        } else {
          // 3-1. Create a new company with a new location to add the current customer.
          const res1 = await callGraphql(ctx, shop, `mutation companyCreate($input: CompanyCreateInput!) {
          companyCreate(input: $input) {
            company {
              id
              locations(first: 1, reverse:true) {
                nodes{
                  id
                  name
                }
              }
              contactRoles(first: 2, reverse:true) {
                nodes{
                  id
                  name
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }`, null, GRAPHQL_PATH_ADMIN, {
            "input": {
              "company": {
                "customerSince": `${new Date().toISOString()}`,
                "externalId": `${memberData.b2bMemberId}`,
                "name": `${memberData.companyName}`,
                "note": `${memberData.representativeSei} ${memberData.representativeMei} 担当者：${memberData.clerkSei} ${memberData.clerkMei}`,
              },
              "companyLocation": location_data
            }
          });
          const res2 = await callGraphql(ctx, shop, `mutation companyAssignCustomerAsContact($companyId: ID!, $customerId: ID!) {
           companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
             companyContact {
               id
             }
             userErrors {
               field
               message
             }
           }
         }`, null, GRAPHQL_PATH_ADMIN, {
            "companyId": `${res1.data.companyCreate.company.id}`,
            "customerId": `gid://shopify/Customer/${customer_id}`
          });
          await callGraphql(ctx, shop, `mutation companyLocationAssignRoles($companyLocationId: ID!, $rolesToAssign: [CompanyLocationRoleAssign!]!) {
          companyLocationAssignRoles(companyLocationId: $companyLocationId, rolesToAssign: $rolesToAssign) {
            roleAssignments {
             id
            }
            userErrors {
              field
              message
            }
          }
        }`, null, GRAPHQL_PATH_ADMIN, {
            "companyLocationId": res1.data.companyCreate.company.locations.nodes[0].id,
            "rolesToAssign": [
              {
                "companyContactId": res2.data.companyAssignCustomerAsContact.companyContact.id,
                "companyContactRoleId": res1.data.companyCreate.company.contactRoles.nodes[0].id
              }
            ]
          });
        }
      }
      status.type = 'success';
      status.msg = `${memberData.email}`;
    } catch (e) {
      console.log(`${e}`);
      status.type = 'error';
      status.msg = `${e}`;
    }
    return await ctx.render('register', {
      app_url: `https://${ctx.request.host}`,
      shop_url: `https://${shop}`,
      logout_url: `https://${shop}/customer_identity/logout`,
      memberData: memberData,
      status: status
    });
  }

  const res = {
    "action": 'login',
    "array": [],
    "message": ''
  };
  if (customer_id === '') {
    res.message = 'Not logged in';
  } else if (api_res == null) {
    res.message = 'Retry to login';
  } else {
    res.action = 'register';
  }

  ctx.set('Content-Type', 'application/json');
  ctx.body = res;

});

/* --- Check if the given signature is correct or not --- */
const checkSignature = function (json) {
  let temp = JSON.parse(JSON.stringify(json));
  console.log(`checkSignature ${JSON.stringify(temp)}`);
  if (typeof temp.hmac === UNDEFINED) return false;
  let sig = temp.hmac;
  delete temp.hmac;
  let msg = Object.entries(temp).sort().map(e => e.join('=')).join('&');
  //console.log(`checkSignature ${msg}`);
  const hmac = crypto.createHmac('sha256', HMAC_SECRET);
  hmac.update(msg);
  let signature = hmac.digest('hex');
  console.log(`checkSignature ${signature}`);
  return signature === sig ? true : false;
};

/* --- Check if the given signature is correct or not for app proxies --- */
const checkAppProxySignature = function (json) {
  let temp = JSON.parse(JSON.stringify(json));
  console.log(`checkAppProxySignature ${JSON.stringify(temp)}`);
  if (typeof temp.signature === UNDEFINED) return false;
  let sig = temp.signature;
  delete temp.signature;
  let msg = Object.entries(temp).sort().map(e => e.join('=')).join('');
  //console.log(`checkAppProxySignature ${msg}`);
  const hmac = crypto.createHmac('sha256', HMAC_SECRET);
  hmac.update(msg);
  let signarure = hmac.digest('hex');
  console.log(`checkAppProxySignature ${signarure}`);
  return signarure === sig ? true : false;
};

/* --- Get a token string from a given authorization header --- */
const getTokenFromAuthHeader = function (ctx) {
  return ctx.request.header.authorization.replace('Bearer ', '');
};

/* --- Get a shop from a token from a given authorization header --- */
const getShopFromAuthToken = function (token) {
  const payload = jwt_decode(token);
  console.log(`payload: ${JSON.stringify(payload, null, 4)}`);
  return payload.dest.replace('https://', '');
};

/* --- Check if the given signarure is corect or not for App Bridge authenticated requests --- */
const checkAuthFetchToken = function (token) {
  const [header, payload, signature] = token.split("\.");
  console.log(`checkAuthFetchToken header: ${header} payload: ${payload} signature: ${signature}`);
  const hmac = crypto.createHmac('sha256', HMAC_SECRET);
  hmac.update(`${header}.${payload}`);
  const encodeBase64 = function (b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') };
  let sig = encodeBase64(hmac.digest('base64'));
  console.log(`checkAuthFetchToken Recieved: ${signature} Created: ${sig}`);
  return [(signature === sig ? true : false), sig];
};

/* --- Whether the given request is embedded inside Shopify Admin or not --- */
const isEmbedded = function (ctx) {
  const embedded = ctx.request.query.embedded;
  // If the app is set embedded in the app settings, "embedded" is set "1", otherwise "0" or undefined.  
  if (typeof embedded !== UNDEFINED && embedded == '1') return true;
  return false;
};

/* --- Get the id from shop domain --- */
const getIdFromShop = function (shop) {
  return shop.replace('.myshopify.com', '');
};

/* --- Get Admin domain and path from shop domain --- */
const getAdminFromShop = function (shop) {
  return `admin.shopify.com/store/${getIdFromShop(shop)}`;
};

/* --- Set Content-Security-Policy header for admin embedded types --- */
const setContentSecurityPolicy = function (ctx, shop) {
  if (isEmbedded(ctx)) {
    ctx.response.set('Content-Security-Policy', `frame-ancestors https://${shop} https://admin.shopify.com;`);
  } else {
    ctx.response.set('Content-Security-Policy', `frame-ancestors 'none';`);
  }
};

/* --- Call Shopify GraphQL --- */
const callGraphql = function (ctx, shop, ql, token = null, path = GRAPHQL_PATH_PAYMENT, vars = null) {
  return new Promise(function (resolve, reject) {
    let api_req = {};
    // Set Gqphql string into query field of the JSON  as string
    api_req.query = ql.replace(/\n/g, '');
    if (vars != null) {
      api_req.variables = vars;
    }
    let access_token = token;
    if (access_token == null) {
      getDB(shop).then(function (shop_data) {
        if (shop_data == null) return reject(null);
        access_token = shop_data.access_token;
        accessEndpoint(ctx, `https://${shop}/${path}`, api_req, access_token).then(function (api_res) {
          return resolve(api_res);
        }).catch(function (e) {
          //console.log(`callGraphql ${e}`);
          return reject(e);
        });
      }).catch(function (e) {
        console.log(`callGraphql ${e}`);
        return reject(e);
      });
    } else {
      accessEndpoint(ctx, `https://${shop}/${path}`, api_req, access_token).then(function (api_res) {
        return resolve(api_res);
      }).catch(function (e) {
        //console.log(`callGraphql ${e}`);
        return reject(e);
      });
    }
  });
};

/* ---  HTTP access common function for GraphQL --- */
const accessEndpoint = function (ctx, endpoint, req, token = null, content_type = CONTENT_TYPE_JSON) {
  console.log(`[ accessEndpoint ] POST ${endpoint} ${JSON.stringify(req)}`);
  return new Promise(function (resolve, reject) {
    // Success callback
    let then_func = function (res) {
      console.log(`[ accessEndpoint ] Success: POST ${endpoint} ${res}`);
      return resolve(JSON.parse(res));
    };
    // Failure callback
    let catch_func = function (e) {
      console.log(`[ accessEndpoint ] Failure: POST ${endpoint} ${e}`);
      return reject(e);
    };
    let headers = {};
    headers['Content-Type'] = content_type;
    if (token != null) {
      headers['X-Shopify-Access-Token'] = token;
      headers['Content-Length'] = Buffer.byteLength(JSON.stringify(req));
      headers['User-Agent'] = 'Burst_Shopify_App';
      headers['Host'] = endpoint.split('/')[2];
    }
    console.log(`[ accessEndpoint ] ${JSON.stringify(headers)}`);
    ctx.post(endpoint, req, headers).then(then_func).catch(catch_func);
  });
};

/* --- Store Shopify data in database (MySQL) --- */
const insertDB = function (key, data) {
  return new Promise(function (resolve, reject) {
    const connection = mysql.createConnection({
      host: MYSQL_HOST,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE
    });
    connection.connect((e) => {
      if (e) {
        console.log(`insertDBMySQL Error ${e}`);
        return reject(e);
      }
      //console.log(`insertDBMySQL Connected: ${MYSQL_HOST}`);
      const sql = `INSERT INTO ${MYSQL_TABLE} ( _id, data, created_at, updated_at ) VALUES ('${key}', '${JSON.stringify(data).replace(/\\"/g, '\\\\"').replace(/'/g, "\\'")}', '${new Date().toISOString().replace('T', ' ').replace('Z', '')}',  '${new Date().toISOString().replace('T', ' ').replace('Z', '')}')`;
      console.log(`insertDBMySQL:  ${sql}`);
      connection.query(
        sql,
        (e, res) => {
          connection.end();
          if (e) {
            console.log(`insertDBMySQL Error ${e}`);
            return reject(e);
          }
          return resolve(0);
        }
      );
    });
  });
};

/* --- Retrive Shopify data in database (MySQL) --- */
const getDB = function (key, table = MYSQL_TABLE, data_key = null) {
  return new Promise(function (resolve, reject) {
    console.log(`getDBMySQL MYSQL_HOST ${MYSQL_HOST}`);
    const connection = mysql.createConnection({
      host: MYSQL_HOST,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE
    });
    connection.connect((e) => {
      //console.log(`getDBMySQL Connected: ${MYSQL_HOST}`);
      if (e) {
        console.log(`getDBMySQL Error ${e}`);
        return reject(e);
      }
      let where = `_id = '${key}'`;
      if (data_key != null) where = `data->"$.${data_key[0]}" = '${data_key[1]}'`;
      const sql = `SELECT data FROM ${table} WHERE ${where}`;
      console.log(`getDBMySQL:  ${sql}`);
      connection.query(
        sql,
        (e, res) => {
          connection.end();
          if (e) {
            console.log(`getDBMySQL Error ${e}`);
            return reject(e);
          }
          if (res.length == 0) return resolve(null);
          return resolve(JSON.parse(res[0].data));
        }
      );
    });
  });
};

/* --- Update Shopify data in database (MySQL) --- */
const setDB = function (key, data) {
  return new Promise(function (resolve, reject) {
    console.log(`setDBMySQL MYSQL_HOST ${MYSQL_HOST}`);
    const connection = mysql.createConnection({
      host: MYSQL_HOST,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE
    });
    connection.connect((e) => {
      //console.log(`setDBMySQL Connected: ${MYSQL_HOST}`);
      const sql = `UPDATE ${MYSQL_TABLE} SET data = '${JSON.stringify(data).replace(/\\"/g, '\\\\"').replace(/'/g, "\\'")}', updated_at = '${new Date().toISOString().replace('T', ' ').replace('Z', '')}' WHERE _id = '${key}'`;
      console.log(`setDBMySQL:  ${sql}`);
      if (e) {
        console.log(`setDBMySQL Error ${e}`);
        return reject(e);
      }
      connection.query(
        sql,
        (e, res) => {
          connection.end();
          if (e) {
            console.log(`setDBMySQL Error ${e}`);
            return reject(e);
          }
          return resolve(res.affectedRows);
        }
      );
    });
  });
};

app.use(router.routes());
app.use(router.allowedMethods());

if (!module.parent) app.listen(process.env.PORT || 3000);
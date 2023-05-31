import { useState, useCallback } from 'react';
import { useAppBridge } from '@shopify/app-bridge-react';
import { Redirect } from '@shopify/app-bridge/actions';
import { authenticatedFetch } from "@shopify/app-bridge-utils";
import { Page, VerticalStack, AlphaCard, Layout, Link, Badge, List, Spinner, Button, CalloutCard } from '@shopify/polaris';

import { _getShopFromQuery, _getAdminFromShop } from "../utils/my_util";

function Index() {
    const app = useAppBridge();
    const redirect = Redirect.create(app);

    const shop = _getShopFromQuery(window);

    const [code, setCode] = useState('');

    authenticatedFetch(app)(`/index`).then((response) => {
        response.json().then((json) => {
            console.log(JSON.stringify(json, null, 4));
            if (json.result.response != null && typeof json.result.response.config !== 'undefined') {
                setCode(json.result.response.config.code);
            } else {
                setCode(' ');
            }
        }).catch((e) => {
            console.log(`${e}`);
        });
    });

    return (
        <Page title="B2B Membership">

        </Page>
    );
}

export default Index
const express = require("express");
const { ory } = require("./ory");
const _ = require("lodash");
const amqp = require("amqplib/callback_api");
const { getParents } = require("./db-queries");
const { graphQLClient } = require("./graphql-client");
const {
    INSERT_ACCOUNT_MUTATION,
    CONNECT_ACCONT_TO_CARD_MUTATION,
    CREATE_WALLET_MUTATION,
} = require("./queries");
// const { pool } = require("./pg-client");

let channel;
let connection;

connect();

// connect to rabbitmq
function connect() {
    amqp.connect(
        "amqp://admin:admin@139.59.234.34:5672",
        function (error0, _connection) {
            if (error0) {
                throw error0;
            }
            connection = _connection;
            connection.createChannel(function (error1, _channel) {
                if (error1) {
                    throw error1;
                }
                const queue = "transaction";

                channel = _channel;

                channel.assertQueue(queue, {
                    durable: false,
                });
            });
        }
    );
}

const router = express.Router();

router.post("/", async (req, res) => {
    console.log(req.body);

    const { flowId, data, myData } = req.body;

    let { cardId, referrerCode } = myData;

    const cookies = Object.keys(req.cookies).map(
        (key) => `${key}=${req.cookies[key]}`
    );
    const cookiesString = cookies.join(";");

    // data["traits"]["card_id"] = parseInt(cardId);
    // data["traits"]["referer_id"] = parseInt(referrerCode);

    try {
        // const registRes = await ory.submitSelfServiceRegistrationFlow(flowId, data, "csrf_token_806060ca5bf70dff3caa0e5c860002aade9d470a5a4dce73bcfa7ba10778f481=TS7+yf9wv3Eumvg2i31X7aRh0mwTsEziY2Ck3XOkxj0=");
        const registRes = await ory.submitSelfServiceRegistrationFlow(
            flowId,
            data,
            cookiesString
        );

        console.log(
            "This is the user session: ",
            registRes.data,
            registRes.data.identity
        );

        res.status(registRes.status);
        res.json({
            success: true,
            data: registRes.data,
        });

        const oryId = registRes.data.identity.id;
        cardId = parseInt(cardId);
        const referer_id = parseInt(referrerCode);

        // insert account

        const insertAccountRes = await graphQLClient.request(
            INSERT_ACCOUNT_MUTATION,
            {
                ory_id: oryId,
                referer_id: referer_id ? parseInt(referer_id) : null,
            }
        );

        // connect card with account

        const account_id = insertAccountRes.insert_account.returning[0].id;

        const updateRes = await graphQLClient.request(
            CONNECT_ACCONT_TO_CARD_MUTATION,
            {
                card_id: cardId,
                account_id: account_id,
            }
        );

        // create wallet
        const createWalletRes = await Promise.all([
            graphQLClient.request(CREATE_WALLET_MUTATION, {
                account_id: account_id,
                wallet_type: 0,
            }),
            graphQLClient.request(CREATE_WALLET_MUTATION, {
                account_id: account_id,
                wallet_type: 1,
            }),
        ]);

        // thuong nguoi dung moi
        channel.sendToQueue(
            "transaction",
            Buffer.from(
                JSON.stringify({
                    account_id: account_id,
                    transaction_type: 1, // 1: reward for new user
                    payload: {},
                    date: new Date(),
                })
            )
        );

        // get parents and push to queue

        const parents = await getParents(referer_id);

        parents.forEach((parent, i) => {
            const { id, name, referer_id, is_agency } = parent;

            if (i === 0 || is_agency) {
                // neu la nguoi gioi thieu truc tiep hoac nguoi do la agency thi thuong?
                channel.sendToQueue(
                    "transaction",
                    Buffer.from(
                        JSON.stringify({
                            account_id: id,
                            transaction_type: 0, // 0: refer
                            payload: {
                                level: i,
                                is_agency,
                            },
                            date: new Date(),
                        })
                    )
                );
            }
        });
    } catch (error) {
        console.log(error.response.data);
        res.status(_.get(error, "response.status") || 500);
        res.json({
            success: false,
            data: error.response.data,
        });
        return;
    }

    // pool.query("SELECT * FROM ", (err, res) => {
    //     console.log(err, res);
    // });
});

module.exports = router;

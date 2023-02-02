import axios from 'axios'
import express from 'express'
import cron from 'node-cron'
import * as SolanaWeb3 from '@solana/web3.js'
import cors from 'cors'
import dotenv from "dotenv"
import bs58 from "bs58"
import { getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Metadata } from "@metaplex-foundation/mpl-token-metadata";
import * as splToken from "@solana/spl-token"

dotenv.config({ path: './.env' })
// dotenv.config({ path: './fake.env' })
const app = express()
app.use(express.json())

// CORS SETUP
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.use(cors({
    origin: "*",
    credentials: true,
}));

// maintaining data for verifications
let airdropActive = false
let lastAirdropTime = null
let currentRewardAmounts = []
let failedStakeholders = []
let totalStakeholders = null
let rewardedStakeholders = null
let stakeholdersInfo = null

// SOLANA CONNECTION SETUP
const connection = new SolanaWeb3.Connection(
    process.env.RPC_URL,
    "confirmed"
)
// const connection = new SolanaWeb3.Connection(
//     SolanaWeb3.clusterApiUrl('mainnet-beta')
// );

// PRIVATE KEY (SECURE IT LATER)
const privateKey = process.env.PRIVATE_KEY //Wallet of airdropper

// ACCOUNTS SETUP
const tokenAddress = process.env.REWARD_TOKEN //Reward token address
const fromAddress = process.env.AIRDROPPER_ADDRESS //Rewarder address (same as airdropper)
const fromPublicKey = new SolanaWeb3.PublicKey(fromAddress);
const tokenPublicKey = new SolanaWeb3.PublicKey(tokenAddress);
const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    fromPublicKey,
    tokenPublicKey,
    fromPublicKey,
);
const fromWallet = SolanaWeb3.Keypair.fromSecretKey(bs58.decode(privateKey));

// FUNCTION TO GET STAKED TOKENS AND DATA MODELLING
const getStakeholders = async () => {
    console.log("Getting staked tokens info through API")
    const stakedTokens = await axios.get("https://stallions.neft.shop/api/stakehouse/v1/statistics/AbvVSTMyZYwLReuoNd5uDqjx9et9uEG8oRXDipCG1SKK/hashlist")
    const stakeholders = stakedTokens.data.items.reduce((reducedArray, x) => {
        (reducedArray[x["stakerId"]] = reducedArray[x["stakerId"]] || []).push(x)
        return reducedArray
    }, {})
    const stakeholdersArray = Object.entries(stakeholders)
    stakeholdersInfo = stakeholdersArray
    return stakeholdersArray
}

// FUCNTION TO GET METADATA OF MINT ADDRESSES
const getMetadata = async (mintAddress) => {
    try {
        let mintPubkey = new SolanaWeb3.PublicKey(mintAddress)
        let tokenmetaPubkey = await Metadata.getPDA(mintPubkey)
        const tokenmeta = await Metadata.load(connection, tokenmetaPubkey);
        const jsonMetadata = await axios.get(tokenmeta.data.data.uri)
        return jsonMetadata.data
    } catch (error) {
        console.error(`FAILED!!! Couldn't fetch token metadata for ${mintAddress}`)
        return {
            symbol: "S"
        }
    }
}

// FUNCTION TO TRANSFER TOKENS
const transferReward = async (toAddress, amount) => {
    console.log(`<-----Reward Transfer Initiated----->`)

    // Variable for error handling
    let isTokenAccount = false
    const toPublicKey = new SolanaWeb3.PublicKey(toAddress);
    let toTokenAccount
    try {
        // CREATING TOKEN ACCOUNT FOR TRANSACTION
        toTokenAccount = await getOrCreateAssociatedTokenAccount(
            connection,
            fromWallet, //payer for creating account
            tokenPublicKey,
            toPublicKey,
        )
        if (toTokenAccount) {
            console.log(`STBL Token Account found for ${toAddress}`)
            isTokenAccount = true
        }
    } catch (error) {
        isTokenAccount = false
        let failedObj = {}
        failedObj.stakeholder = toAddress
        failedObj.rewardCount = amount
        failedObj.reason = "No token account found for STBL token"
        failedStakeholders.push(failedObj)

        // console.log(error)
        console.error(`FAILED!!! couldn't GET any STBL token account for ${toAddress}`)
    };

    try {
        // SIGNATURE
        const signature = await splToken.transfer(
            connection,
            fromWallet,
            fromTokenAccount.address,
            toTokenAccount.address,
            fromWallet.publicKey,
            amount * Math.pow(10, process.env.DECIMALS)
        );
        console.log(signature)
        return signature
    } catch (error) {
        if (isTokenAccount) {
            let failedObj = {}
            failedObj.stakeholder = toAddress
            failedObj.rewardCount = amount
            failedObj.reason = "Unknown transfer error occured"
            failedStakeholders.push(failedObj)
            console.log(error)
            console.error(`FAILED!!! Couldn't transfer reward to ${toAddress}`)
        }
    }
}

// STABLES TYPES INFO OBJECT
const stallionBase = 2
const boarBase = 0.5
const stablesTypes = {
    Racing: {
        hold: 1,
        multiplier: 2,
        base: 2
    },
    cowboy: {
        hold: 2,
        multiplier: 2,
        base: 6
    },
    medieval: {
        hold: 2,
        multiplier: 3,
        base: 8
    },
    degen: {
        hold: 3,
        multiplier: 3,
        base: 15
    },
    future: {
        hold: 3,
        multiplier: 4,
        base: 18
    },
    degen_animated: {
        hold: 4,
        multiplier: 5,
        base: 24
    },
    future_animated: {
        hold: 5,
        multiplier: 6,
        base: 30
    },
}

// REWARD CALCULATING ALGORITHM
const calculateReward = async (stakeholders) => {
    let stakeholdersRewards = []
    for (let i = 0; i < stakeholders.length; i++) {
        console.info(`<${i + 1}> Calculating REWARD for ${stakeholders[i][0]}: Total Staked: ${stakeholders[i][1].length}`)
        let rewardObj = {}
        let totalReward = 0
        let stallionStaked = []
        let boarsStaked = []
        let stablesStaked = []

        for (let j = 0; j < stakeholders[i][1].length; j++) {
            console.info(`${j + 1}/${stakeholders[i][1].length}: Getting METADATA of ${stakeholders[i][1][j].mintId}`)
            const metadata = await getMetadata(stakeholders[i][1][j].mintId)
            if (metadata) {
                if (metadata.symbol == "S") {
                    stallionStaked.push(stakeholders[i][1][j].mintId)
                } else if (metadata.symbol == "STABLE") {
                    stablesStaked.push(metadata.attributes[0].value)
                } else if (metadata.symbol == "BB") {
                    boarsStaked.push(stakeholders[i][1][j].mintId)
                } else {
                    console.log("Wrong Metadata token Found")
                }
            }
        }
        console.info(`${stallionStaked.length} stallions Staked by ${stakeholders[i][0]}`)
        console.log(stallionStaked)
        console.info(`${boarsStaked.length} Boars Staked by ${stakeholders[i][0]}`)
        console.log(boarsStaked)
        console.info(`${stablesStaked.length} stables Staked by ${stakeholders[i][0]}`)
        console.log(stablesStaked)

        const stallionsNum = stallionStaked.length
        const boarsNum = boarsStaked.length
        const stablesNum = stablesStaked.length

        if (stallionsNum && stablesNum || boarsNum && stablesNum) {
            console.log("either stallions/stables are staked or either boars/stables are staked...")
            // Calculating reward for the stallions according to the priority stables, their hold and multiplier
            let stablesPriority = ['future_animated', 'degen_animated', 'future', 'degen', 'medieval', 'cowboy', 'Racing']
            let stallionsCount = stallionsNum
            let boarsCount = boarsNum

            // Calculating reward for the stables staked according to their base emit
            stablesStaked.forEach(i => {
                let valueForEachStable = stablesTypes[i].base
                totalReward += valueForEachStable
            })

            if (stallionsNum) {
                // console.log('Both stallions and stables are staked')
                const configPriority = () => {
                    for (let i = 0; i < stablesPriority.length; i++) {
                        for (let j = 0; j < stablesStaked.length; j++) {
                            if (stablesPriority[i] == stablesStaked[j]) {
                                if (stallionsCount <= stablesTypes[stablesPriority[i]].hold) {
                                    // console.log("Stallion count is less than Stable Hold")
                                    const rw = stallionsCount * stallionBase * stablesTypes[stablesPriority[i]].multiplier
                                    totalReward += rw
                                    stallionsCount -= stallionsCount
                                    break;
                                } else {
                                    // console.log("Stallion count is More than Stable Hold")
                                    const rw = stablesTypes[stablesPriority[i]].hold * stallionBase * stablesTypes[stablesPriority[i]].multiplier
                                    totalReward += rw
                                    stallionsCount -= stablesTypes[stablesPriority[i]].hold
                                    stablesStaked.splice(j, 1)
                                    // console.log(stablesStaked)
                                    configPriority()
                                }
                            }
                        }
                    }
                }
                configPriority()
                if (!stallionsCount) {
                    console.log("All stallions gone")
                } else {
                    // console.log("Few stallions remaining")
                    totalReward += stallionsCount * stallionBase
                }
            }

            // Calculating for boars staked, they come after stallions in priority
            if (boarsNum) {
                console.log("boars and stables are staked..")
                if (boarsNum && stablesStaked) {
                    console.log("some stables are left for boars...")
                    const configPriority = () => {
                        for (let i = 0; i < stablesPriority.length; i++) {
                            for (let j = 0; j < stablesStaked.length; j++) {
                                if (stablesPriority[i] == stablesStaked[j]) {
                                    if (boarsCount <= stablesTypes[stablesPriority[i]].hold) {

                                        const rw = boarsCount * boarBase * stablesTypes[stablesPriority[i]].multiplier
                                        totalReward += rw
                                        boarsCount -= boarsCount
                                        break;
                                    } else {
                                        // console.log("Boars count is More than Stable Hold")
                                        const rw = stablesTypes[stablesPriority[i]].hold * boarBase * stablesTypes[stablesPriority[i]].multiplier
                                        totalReward += rw
                                        boarsCount -= stablesTypes[stablesPriority[i]].hold
                                        stablesStaked.splice(j, 1)
                                        // console.log(boarsStaked)
                                        configPriority()
                                    }
                                }
                            }
                        }
                    }
                    configPriority()
                }
                if (!boarsCount) {
                    console.log("All boars gone")
                } else {
                    console.log("Few boars remaining")
                    totalReward += boarsCount * boarBase
                }
            }
        } else {
            console.log('Either of stallions and stables or boars are staked')
            if (stablesNum) {
                // Calculating reward for the stables staked according to their base emit
                stablesStaked.forEach(i => {
                    let valueForEachStable = stablesTypes[i].base
                    totalReward += valueForEachStable
                })
            }
            if (stallionsNum) {
                // Calculating reward for stallions not held in stables
                totalReward += stallionsNum * stallionBase
            }
            if (boarsNum) {
                totalReward += boarsNum * boarBase
            }
        }

        rewardObj.toAddress = stakeholders[i][0]
        rewardObj.rewardAmount = totalReward
        console.info(`${i + 1}: REWARD INFO FOR ${stakeholders[i][0]}: ${rewardObj.rewardAmount} tokens`)
        stakeholdersRewards.push(rewardObj)
        currentRewardAmounts.push(rewardObj)
    }
    return stakeholdersRewards

}

// MAIN AIRDROP FUNCTION
const airdrop = async () => {
    airdropActive = true
    currentRewardAmounts = []
    failedStakeholders = []
    // const stakeholders = await getStakeholders()

    // totalStakeholders = stakeholders.length
    // console.log("STAKEHOLDERS RECEIVED", totalStakeholders)
    // const stakeholdersRewards = await calculateReward(stakeholders)
    // console.log(stakeholdersRewards)
    const stakeholdersRewards = [
        {
            toAddress: "7FuDw2M5HRigqpNHrGeLLeBGKX62waAAmgbhww9j7zV6",
            rewardAmount: 744
        },
        {
            toAddress: "4EJnD5UBezGFvJSnbBybi3xWrzHoqzbe1ShVitooUbTm",
            rewardAmount: 16
        },
        {
            toAddress: "6VdtoWFcwBeKAhCxUpRMyjjKg8Pxy1kHpF539E7G9533",
            rewardAmount: 2
        },
        {
            toAddress: "6nXLDU4UAF3LJhiTjXwSo1i6rcAn2Kcshu9uTc4x9LxR",
            rewardAmount: 14
        },
        {
            toAddress: "GkbhnRrP5qvk5vzTwEwiGJxnc4sW57LzWMDvUtmpEj73",
            rewardAmount: 3
        },
        {
            toAddress: "5HvANfuUHx3C4qQ3eyvRrpPLhSWMsoXHKvtShCcGzVnG",
            rewardAmount: 2.5
        },
        {
            toAddress: "79ffZJpoe5YiYNACAFNhymwcLKJWoapU3dADV2Pf7rAc",
            rewardAmount: 44
        },
        {
            toAddress: "AUkfoCVpJXD1oZRaPRKa2xqKegKPQ6goLz8PfmUQqzrr",
            rewardAmount: 4
        },
        {
            toAddress: "8NumK7feqVAdEj8LYSvv33qRCw4GQAV8Wm8ysR5E78sV",
            rewardAmount: 112
        },
        {
            toAddress: "GoyeGaJHSkVV5PBBaeM9uWbKa2UMx79FvUDkcmb6VWoD",
            rewardAmount: 18
        },
        {
            toAddress: "8FFdNmtjqYRZmuW2TBFM5gq72N3eHPStJ2U8syHsuUP9",
            rewardAmount: 173
        },
        {
            toAddress: "AWzVBC86C5qdhvp9GFYuT8phSZNHEBB87FHFqnxLzxEq",
            rewardAmount: 111
        },
        {
            toAddress: "EW66SX1beB3v4LmXAqCHtSQAJA4XRsiW8jtZhq7C3NQK",
            rewardAmount: 49
        },
        {
            toAddress: "4AQzjAR834gij48pHTQVi6LVCpiWh9e5rCxZ46LpcTLN",
            rewardAmount: 68
        },
        {
            toAddress: "4Pnp3EMUHPnXy793BBFAbG4HP3dEux5HvccncFxhr9vT",
            rewardAmount: 51
        },
        {
            toAddress: "7wkFKVPsnCz7MJDRC3t9FsVyMHMk9yJMazJuWqsVFZzy",
            rewardAmount: 36
        },
        {
            toAddress: "AE2Xm7iKgbK9yFvnYLDMPHmwQyevzdJP4xd9yPvhL98G",
            rewardAmount: 114
        },
        {
            toAddress: "61qP7E6LrC4uxn3tKx49bCSzGF3oXy2wEqehNTZrVtwP",
            rewardAmount: 280
        },
        {
            toAddress: "HA2JmCPp1zs6R7oqki3CafM1XhhV9aGWVaqziyQpQFz8",
            rewardAmount: 58
        },
        {
            toAddress: "7fy7WssRwez15AaxMcVkyjqHu78WXkL2QH4eZyhmJ9pS",
            rewardAmount: 22
        },
        {
            toAddress: "A6hnh9romT5dkNhDF4GHgF7qM3dV6kddxCNVaoGrutpR",
            rewardAmount: 73
        },
        {
            toAddress: "BUVvmHZhS3ueB8MUvca9RpfrfMsYoNbyJ24EG9u9mDuN",
            rewardAmount: 178
        },
        {
            toAddress: "FujugFjoYB7VyNA4j5Yi2ihgozN2mxrWKWhtpL7uh4Yk",
            rewardAmount: 213
        },
        {
            toAddress: "Bo3zPy49coBPRyfjKRGnqQhZUGqSKw4ssY2TmGockSQ8",
            rewardAmount: 6
        },
        {
            toAddress: "HXMzS9Ji3BjdJGxcpeMBkmErt9amuwDZcKTj6fSbsXs1",
            rewardAmount: 12.5
        },
        {
            toAddress: "4dRd9DkACxyPeQb2UVVHVxHSJKQSFBVA6Mgmkmep5f6S",
            rewardAmount: 278
        },
        {
            toAddress: "CgSQAuLwjTuLPx4pizQdjzTZWga3su3Fag8TTdM326UA",
            rewardAmount: 445
        },
        {
            toAddress: "5VdVPc6CPKagUfALftbeV11W1LzocmEk4yi9dZGh6ZXe",
            rewardAmount: 99
        },
        {
            toAddress: "HcqxXqqE2B5jjqeopjSRwz7vtnUBjLZM9BmncAiXGK3F",
            rewardAmount: 2
        },
        {
            toAddress: "EeC7G7e4jnvWW9vNzWXiUcRWetCW9AcYrqLjUHS111kJ",
            rewardAmount: 182
        },
        {
            toAddress: "86ZedEUdiEEprqCnVdNna4k6cLcXUC6Vpc1WMhfEBfkz",
            rewardAmount: 88
        },
        {
            toAddress: "9q5R3B2mHnLJ939HY76ELS5mZ4KoL9bYzqJHE12Bbb5Y",
            rewardAmount: 81
        },
        {
            toAddress: "3Wua8PxXiW579SETPvQNbNf1KS7NzGCUAkguVEvJMfxe",
            rewardAmount: 47
        },
        {
            toAddress: "AHPBym22bNyGDu5qKSsHtrQLmYdS3Q6d5MrQKPgyGdfX",
            rewardAmount: 130
        },
        {
            toAddress: "6u2ze9HRDZMCSDHgTZ2VmMg9x5apkmYAgEobBRrGTtec",
            rewardAmount: 147
        },
        {
            toAddress: "3drXcyThJ6VzKDicgyHFBj5qDmFYsVnhQxYGzFkgBdmE",
            rewardAmount: 14
        },
        {
            toAddress: "3a6drb6BCPuaVCRY2Qk2ckNjPo7xJPha9ZiCBB71xppz",
            rewardAmount: 102
        },
        {
            toAddress: "9z8Zi8vn8FzHUrMQt7AhWz1mzFStjJPp3XgRdJi3MZqG",
            rewardAmount: 114
        },
        {
            toAddress: "GNg3TcXhSnxN1HStpF481HF8xJFHz9UXQV56QBgWdHen",
            rewardAmount: 24
        },
        {
            toAddress: "2PBbTVRGR89sSG9tSM9oA826PLLzsWSHnbgGkiZyVoDt",
            rewardAmount: 101
        },
        {
            toAddress: "BLutUQavQ9nHTMJgqHFxDcbYxDMUZpDp44FqJ1SpdGqe",
            rewardAmount: 75
        },
        {
            toAddress: "G3wEJPi3pHnUPduc2isPc2VLuHo3vsnxCHjeNPj8ZT7n",
            rewardAmount: 159
        },
        {
            toAddress: "4547gZYggTgmF3EAPnYTT8n9sDpnswFPwFvPQWkEZ4KS",
            rewardAmount: 142.5
        },
        {
            toAddress: "EZeLheSxWx2QdXfszzkJZLcX2DCiwEeEF7fS3HXLYHEd",
            rewardAmount: 2
        },
        {
            toAddress: "FvTgBqpzn3PD58ESWNrGzjy88xxmvAZSaNj3LFsKSCAd",
            rewardAmount: 15.5
        },
        {
            toAddress: "7HFnc9B39ieqdWZWw2k2A878dQXtMw95mHt5yTDxZZqS",
            rewardAmount: 52
        },
        {
            toAddress: "C3GQibpY2MNVmBbvtWE4REvh9LL5PRcpCmXkQYRidqah",
            rewardAmount: 20
        },
        {
            toAddress: "AYMFHVsTmWF6f6tR7RTck6ZQhk51YQJLiPyZaQFoaCkq",
            rewardAmount: 32
        },
        {
            toAddress: "6GX4byAuMg2Tnsah9H3J1NTJZ6anY6T2KzKX33J9Gg4X",
            rewardAmount: 50
        },
        {
            toAddress: "AbBNqz9qtVm6AZfxWv9BQmSZw1R43Kvxa4Gv4Jw9iVsE",
            rewardAmount: 117
        },
        {
            toAddress: "CxX2yhU3a1UfwiZdYK89qArDugFF5w1vQ6wA5LsSnvgK",
            rewardAmount: 16
        },
        {
            toAddress: "CyWXZ1KhybGahbvuMZxcubcLejjV2kLUQKrxqm7ZeFPF",
            rewardAmount: 303
        },
        {
            toAddress: "4JFvLyyrKakNiWmrJbNbxjntMEnrEEB9KhBBCiJA3ssy",
            rewardAmount: 170
        },
        {
            toAddress: "A79hjbKYNcWds5RFjsfrhumod8gifTjbZTJvqtKsSrz2",
            rewardAmount: 152
        },
        {
            toAddress: "3tn9kjr1cZizkRpE2Hw58PKn98fe4jRg41mdkCxj47dr",
            rewardAmount: 22
        },
        {
            toAddress: "3544atQ9KGd4HXF8s4xVuaT7Scv5j4JuexDGiF4fXqDk",
            rewardAmount: 16
        },
        {
            toAddress: "6vLNA4ZfLZkUSoEuuDGcZJjcrByXbx525wn7KUiakTk3",
            rewardAmount: 20
        },
        {
            toAddress: "9Gs1T6APifxuJrP4E7VveGMREaceZzQQH8RJSNzRzMSU",
            rewardAmount: 3
        },
        {
            toAddress: "8Lqmk8uWSd5AnWZzAeA4nsnY9TtHKwdZ1SMCFc47us5K",
            rewardAmount: 18
        },
        {
            toAddress: "ctt7TSSjt9Ljt7TNwDvfmdMTUNARuJDkSjnupe9aXpg",
            rewardAmount: 22
        },
        {
            toAddress: "CqroZJxHFNHZGPELu8s9mMwHDsWGpTsneAXzamoTBKwy",
            rewardAmount: 2.5
        },
        {
            toAddress: "HNrc4naXVWabkd76z7PfVuHT9Fa6aGPEZMTJD8mCNaGG",
            rewardAmount: 62
        },
        {
            toAddress: "4EiVdx9EotRmnNbMfq79N5fGVNVh9VmZJ4ykhRB2HE77",
            rewardAmount: 6
        },
        {
            toAddress: "HkkqUDVtjrj1jwnRBa7dS1wsnXA4pHAh4XpVrjVJQQXd",
            rewardAmount: 46.5
        },
        {
            toAddress: "GQrM1LbUVSwrvmzfR4BGujXYGTUpuJEC3YQwCZntVHkg",
            rewardAmount: 1.5
        },
        {
            toAddress: "9NsoMvCe7ab99oGxjBnYyxCuuVHP2qgC3PPmWH7zNbwU",
            rewardAmount: 2.5
        },
        {
            toAddress: "B71QDVk2fstva9LejGCZN3tXjWANgJ74cj5GEEheLes3",
            rewardAmount: 133
        },
        {
            toAddress: "7vYsEa1sgyVkkyWKpVbytUqmSfD2uRjAFNdNE7G8vSTX",
            rewardAmount: 0.5
        },
        {
            toAddress: "8wYyfC7jjRz8wZGzaD1xduQH6CMVSC3QpnhrrmwxQQce",
            rewardAmount: 26
        },
        {
            toAddress: "dTMTTgdXiQzmMfGGRUps2RV2cV8QbC7os5E7127wG27",
            rewardAmount: 36
        },
        {
            toAddress: "8YjKof99zLqTXdZhp9FyjqH1aYk6GTYEdsyzMyXW4URz",
            rewardAmount: 4
        },
        {
            toAddress: "AXyYGPsspnnskG29Mo7cDRQANN8FvGfUiSbrp4X6QbhN",
            rewardAmount: 14.5
        },
        {
            toAddress: "8HNbrX58GJV1XreERF6n7kuNZFJXomLAxnzmNACSw7Z5",
            rewardAmount: 291
        },
        {
            toAddress: "EH3BvwhzA9tatT8nYS9x53m1e48Snjm5WHgnuiAEgCFK",
            rewardAmount: 14
        },
        {
            toAddress: "5ri21PFMEQ36sYik6ndy7DKVhea3vyZSVUoe7ErTsahs",
            rewardAmount: 188
        },
        {
            toAddress: "3A3KsWngsBqo4n5Uv2wmhi8fS2pQKQFCP6dnCAJxLJyr",
            rewardAmount: 26
        },
        {
            toAddress: "GpNLftwbAPy93qgLCAerBZsgNJbV96P1VEKuSHwujYsM",
            rewardAmount: 8
        },
        {
            toAddress: "7wPgb4DUHFy3kFzj7MNeqEBgaX3SKSNDoc1ETunu9ioS",
            rewardAmount: 20
        },
        {
            toAddress: "B8f76648UjHSVczFWxi5AzrFGuMArGgXcFd52QVtCRUJ",
            rewardAmount: 217
        },
        {
            toAddress: "4C893CK2TF4QYGndE2xDUU2eqPRzYKZWxWNAwuoQMKDC",
            rewardAmount: 61
        },
        {
            toAddress: "DjvUysMQRdFgNyzyZXEQSsehwB4BRVkf8BNdyQCCHemc",
            rewardAmount: 44
        },
        {
            toAddress: "B8zmukUQZVjQSj821LFrWjLXCZQr9bpTjd3etLtvnxya",
            rewardAmount: 33.5
        },
        {
            toAddress: "EFnFXDsfKBvxn6hdDGbYHo32jDjmz4dZgAwH8sRZRM4Q",
            rewardAmount: 4
        },
        {
            toAddress: "2gjBWLhTxoYUtZsYEVcg1ghayY9st3VVeZca2i8h9e5P",
            rewardAmount: 4
        },
        {
            toAddress: "8Rp4VnstXdY1chDrvVysPjudGoKrCahLzjepW6X2CiMU",
            rewardAmount: 4
        },
        {
            toAddress: "4zcTvQRjZ1eBK4tDntQ1SHgj2DV62SECKbqQmpkAQ1r5",
            rewardAmount: 54.5
        },
        {
            toAddress: "CxunDF3j4ZTc7yBsD7J36tRRHFBBirLsRwVKyuBfXosN",
            rewardAmount: 59
        },
        {
            toAddress: "DwGP86dGhXCAv3TQBse6SmqGZHJTrfJ2vG37kALifzhX",
            rewardAmount: 6
        },
        {
            toAddress: "CGZszhLoy6f2K1GR7NmKQ6hLTsW7Z8KHpdWPgM99yS1F",
            rewardAmount: 53
        },
        {
            toAddress: "7hF2t9bppkN6gGwkBWK2b4thAEvSKndnPXWcY1xSxxPR",
            rewardAmount: 8
        },
        {
            toAddress: "HToCFBStWe5B3doYeGuvjkxqR5Bp41pSbPiFqVZQ8EeL",
            rewardAmount: 13
        },
        {
            toAddress: "48zihPEtZxCypb3qNmUQrbmkCpJNwsVS2NTMaUEWqmnL",
            rewardAmount: 4
        },
        {
            toAddress: "Hv2MBy29E1DJpkE9NGAJsC8XXRFQkL3FzvnczpB7WNRY",
            rewardAmount: 1
        },
        {
            toAddress: "BSz5sDAfVZsKkqQNZMg3Bh9kxy3KHd1WZckjgxEzCGHD",
            rewardAmount: 12
        },
        {
            toAddress: "BCMQ2HPzVMuaQ1khjNrhgr1iBWrTwevTSe2WGBDaLAdz",
            rewardAmount: 4
        },
        {
            toAddress: "6nrUMhbGeYsdHHPuAhpPL6ct2vXxn7dXjApVQFruJf4",
            rewardAmount: 8
        },
        {
            toAddress: "4mUh9FfVorjScJqh7fDAp9bFdLoceZp196uLCNEMdRvC",
            rewardAmount: 20
        },
        {
            toAddress: "BmKQCUW6QD7ub9kXLvsCkKogdCSmgo5d5LjvKgEyzk5f",
            rewardAmount: 6
        },
        {
            toAddress: "GF8yNpAFmRduULaTMcrHUcFoVMPckWqwP4JooMXu8fqa",
            rewardAmount: 279
        },
        {
            toAddress: "XpK7zRRrSdyshY7JZp4Cosy4qwiBn35CNReCgQNw1Km",
            rewardAmount: 1.5
        },
        {
            toAddress: "EX52Tbi9ZeRhJUd3fFZjBjZs8CWN6xGw3dcCmmwrfdq2",
            rewardAmount: 5
        },
        {
            toAddress: "CE6kWcd367Ah8EF1GtKgXX6mkXvk37NmBJmBsCj7qYR",
            rewardAmount: 14
        },
        {
            toAddress: "EcMJCJj33ftLPeNC5MpHg5fgA4myopcs2UVmhcXSvdMW",
            rewardAmount: 5.5
        },
        {
            toAddress: "DfTDCALF4YJ7yWGjqkJm4nGNqDneN87FrR242miSBZiJ",
            rewardAmount: 14
        },
        {
            toAddress: "A1Mzn7XZ3rnMapYA9CNP6KVzgbTkQmDqWtRBtVGW5e9D",
            rewardAmount: 64
        },
        {
            toAddress: "3ChrkEWY6QRGqTRSBxZNrZstvT7TtCBPzG3gZm2m6t42",
            rewardAmount: 43
        },
        {
            toAddress: "GHaTYByKNJ3LF2rvLPTj3pQYXN5oEaYg7uTx1FXrGQ2L",
            rewardAmount: 40
        },
        {
            toAddress: "3y8LZDMxd2XZ7XuTMLsfh6n3EVxFZ58iwSD9CBfjyryZ",
            rewardAmount: 6
        },
        {
            toAddress: "H4MxV1rD4SbaXzyos9P8C5aH5BL81dqFpFcFChbtSkPf",
            rewardAmount: 8
        },
        {
            toAddress: "8rf83DGBFbbSyFJegf617F5WhKqUKu19n9k6U2vSCASv",
            rewardAmount: 4
        },
        {
            toAddress: "CvqtsyLmPcP8HE6vsdJn14wCPvM59Ge2gkzy8TUfme59",
            rewardAmount: 1
        },
        {
            toAddress: "4yMhPbEVNUeApfwsu5iQZ98V4GFe2eDLpFaCQ3jBn9gT",
            rewardAmount: 66
        },
        {
            toAddress: "6gk3d2BPuZS8SATfdgGnu4KVqXDNKNjS4NvkheiPBNpe",
            rewardAmount: 7.5
        },
        {
            toAddress: "DhELYVSVYCDamQ6EsFLny3t5EkvTdiJE7sTWPSAnkhYC",
            rewardAmount: 20
        },
        {
            toAddress: "BfyJZohSmReXSYUjYX29UgVWNoaMpzozfw1vyUsvWhoJ",
            rewardAmount: 68
        },
        {
            toAddress: "FFLrXXt9mv2tspMZFzEzzzPP2rcpbesDC6AuPLENZQ2m",
            rewardAmount: 2
        },
        {
            toAddress: "HPdLaKJaUDvC3NffFmn9wLrfMWVmCWS1iV53Q9htt9J7",
            rewardAmount: 28
        },
        {
            toAddress: "GEisuU9fzXWCQPm3g9WW6nkjq3jPWzCFzocJ5v2q66Td",
            rewardAmount: 6
        },
        {
            toAddress: "D4jjGhNTce5Jvf3kJ52vkCfJty4Y5d2iqm9jDxTKGHzx",
            rewardAmount: 85
        },
        {
            toAddress: "DxPJv9VVSRRJMC3wL1JN59Ue54ZemjD8zm2fKkLpYHXj",
            rewardAmount: 6
        },
        {
            toAddress: "2NEqryGiJVwTxfY1Trf623hUD7cZwb9JxBLaPoRQeiUw",
            rewardAmount: 20
        },
        {
            toAddress: "75BVNypdZmVqtjnUXmBboVgQnVeqPQbGKRb4pKAgRC7k",
            rewardAmount: 16
        },
        {
            toAddress: "CVULJUwJ1yy2CJqSvj6zwnB6vgthQeLercAzs3aceuN",
            rewardAmount: 6
        },
        {
            toAddress: "HdSom6LLtLwRfGw7nKegt6r3Z56baNLAU3yRmWqrLFji",
            rewardAmount: 8
        },
        {
            toAddress: "AhrCofPHARrmQ3qi3sQ9Kf8jnu29e5rZdUNrGwEaixn9",
            rewardAmount: 54
        },
        {
            toAddress: "B5EMUWVgDSAEtyy9pKptxDvPvN3BiJz9skwkNLZ24Ctx",
            rewardAmount: 54
        },
        {
            toAddress: "AfwFDNF5URA6dFDosTJdJag6qL33BQNhYY3V1C2Wv6FB",
            rewardAmount: 30
        },
        {
            toAddress: "FanPaZi4BAQHJEYX827mXhCYtWsA61tcZYk4Hz9GQrAx",
            rewardAmount: 2
        },
        {
            toAddress: "EWv248jhuiyo5drvhnS4GLmBAbQtxXRP9ERWfpebchg6",
            rewardAmount: 69.5
        },
        {
            toAddress: "9vmWen4G2HK2y14HC6DhA3FzYbCMHARJzP724uyBavkY",
            rewardAmount: 28
        },
        {
            toAddress: "A67xcD5h2zWxwhGtGnqvWSjbfX7UJiMrJKvrCmsaQeuL",
            rewardAmount: 94
        },
        {
            toAddress: "Ajb2T86o5Kt6b1EmxyMgustqvD99Ybu7MsPPQrXBhogg",
            rewardAmount: 8
        },
        {
            toAddress: "FYYpQ4G6yRphEya9XAmeyQGHTFkoS3W3AcPVHP5Qjb1e",
            rewardAmount: 2
        },
        {
            toAddress: "33tvCvfnnMjs6YLdAShBZxaKZ6VTK29fPqQG4bbhnqyo",
            rewardAmount: 46
        },
        {
            toAddress: "EtF9CDFKxDLJHvq1bgaegBGbGfwjwSYN1bqMCwDJ94V6",
            rewardAmount: 12
        },
        {
            toAddress: "C6o7A22NRUa2XiD5k2HXASW8d1yoVif6vy6erLWnSMst",
            rewardAmount: 14
        },
        {
            toAddress: "5zqtC7wj5p3i36v6L8T19KmWJhorwikjT5bBcMf8RDTe",
            rewardAmount: 4
        },
        {
            toAddress: "9zpFpGSTNHX7VgPsAfCDT2oJSSKB5kAojxJmdETaTnqR",
            rewardAmount: 6
        },
        {
            toAddress: "FTpXQwRpXZymA1nTTMk6QqNhP6aTfsjBECCcXJJxoHEF",
            rewardAmount: 3
        },
        {
            toAddress: "2fha8R6ErYAA9depJvC17FRjPU2si6xuGx1mH5Y6D8PM",
            rewardAmount: 10
        },
        {
            toAddress: "EmqkC7yy1V2RqEvATeUGR9shBae8zNk3UpEZMtLqRFiz",
            rewardAmount: 42
        },
        {
            toAddress: "CTrwrMjzaVWgDhxuQeAYHQyLQQGif5Awt2mYRM6nweTu",
            rewardAmount: 25
        },
        {
            toAddress: "71YGWfXfSWVak7DtQVMUboE6eztCGTpFnBatHj4L1npY",
            rewardAmount: 108.5
        },
        {
            toAddress: "6WzTir7LX8Dcn4Z2R47awF7hsZy717iUvVvCTj4AMen8",
            rewardAmount: 2
        },
        {
            toAddress: "CG5yAJn2J6SgAoDakw9wHp5NqPpNyQdgBKciaQCfGRcj",
            rewardAmount: 1.5
        },
        {
            toAddress: "5uKbZ8z7yzkhR8US4A48oKMsKiw2L4iqUFsuATpnRTxn",
            rewardAmount: 6.5
        },
        {
            toAddress: "8PFLQCWK837Y42caZ2Xw4d6bnL4TrnVTVZB21KTkkVm4",
            rewardAmount: 2
        },
        {
            toAddress: "4ThXJrvoG5iDtLzH8nBgeidkw5TLxt6WRQv84oKzckox",
            rewardAmount: 25
        },
        {
            toAddress: "9YQMX5eW3bjqPqkdogBzGWGvWqicEqGstPTdU2XTFsSF",
            rewardAmount: 18
        },
        {
            toAddress: "2Nn964n4dKPYPdqHj1XHTAwuLEFuE11jZQjR5A5uHJPv",
            rewardAmount: 32
        },
        {
            toAddress: "5ktBVGj6PgWp4HbNPVA7tzaEaEYrrni9XWiWsTY7SWJW",
            rewardAmount: 20
        },
        {
            toAddress: "D6DACvMvgPrYRaXtLPwXXGEDvpZKbtfcuDWodT2x8Aiy",
            rewardAmount: 14
        },
        {
            toAddress: "2WrAvZ4mSfnUf3fwy91Vw9ckL3k6uyx8csDFj3otPGjT",
            rewardAmount: 1.5
        },
        {
            toAddress: "WTGtVbrsN2mQg54yen36F5twviwx5S9PUDJVewAeG4B",
            rewardAmount: 2
        },
        {
            toAddress: "4K4zRXJvC9UGDNbvxetfyjoEjnoAWRAhnMJNq2Qoh5oF",
            rewardAmount: 42
        },
        {
            toAddress: "HyaNrkLdXcqtA26bi9B2JRx5xvwMcM9CKwBe96CCKEoa",
            rewardAmount: 2.5
        },
        {
            toAddress: "CxNkB2JgoyMmrWqGjn3M8eZu2PRR11tqJUSdtK6cCqN3",
            rewardAmount: 4
        },
        {
            toAddress: "AjzZNmDyGEA2sULWVYc2EuCheUKLgV25Ty5Z8Djse3ge",
            rewardAmount: 4
        },
        {
            toAddress: "4pzChAoJYodX5Xj5bxSMLvjRrQoW7zvkpWkTtoqWK8tu",
            rewardAmount: 39
        },
        {
            toAddress: "5JQZpgEBqg9QUHJ9qH8eibJ43nXrQxkvsGWtBtxXSe8r",
            rewardAmount: 34
        },
        {
            toAddress: "feHzcSUvwuDAttwDHujAcPXqAJ5bXGCPD92p6tLazjf",
            rewardAmount: 18
        },
        {
            toAddress: "4x74pNQvfwaxLYUcHaGiMi7CtZy2ubcj3ZALtra4diQ9",
            rewardAmount: 18
        },
        {
            toAddress: "8eNE8f7BU43tXjtwX5QVExmZMP4BsZsz82kAVgHZqDUm",
            rewardAmount: 26
        },
        {
            toAddress: "37pdoy1CTDawsqqPiaDvuWVkcTZLzdFLNFHV6u3HTA5q",
            rewardAmount: 8
        },
        {
            toAddress: "AtJDgbdqgv1hKNZb8CEqWqz3yzwH8bEamrpis2TVPMgn",
            rewardAmount: 22
        },
        {
            toAddress: "5w6XmHFtiGiSmGyK4n5QxkR34fFwrtK8wsXdQt1UFHGZ",
            rewardAmount: 8
        },
        {
            toAddress: "6N9iJAyjgUM2fm1jAF2pLbFQFJSrTCjh8v2tHPwRRBTR",
            rewardAmount: 226
        },
        {
            toAddress: "97tDHXBvUHqKEYT5Suhav6cWvLAW67rz5iT65MzhUuRo",
            rewardAmount: 20
        },
        {
            toAddress: "ChbNFSTxw11TLVCFZ3rPWq51w5YpttnkcVhgdXxu4cgK",
            rewardAmount: 52
        },
        {
            toAddress: "GEkf3skm9zpoNc8inKnCWgADMcmGmaQzW7WzmyB5BAbv",
            rewardAmount: 0.5
        },
        {
            toAddress: "4MYB9BJBDwXch9YKJJ88GRYdwsaoYCCuHkp94UG7JVRJ",
            rewardAmount: 1
        },
        {
            toAddress: "2ya7Ya8xWXWqa5NAWSz6R7ufAKuKntwxgBKT7WyjQ98Q",
            rewardAmount: 26
        },
        {
            toAddress: "34LC8yeWoqknaFmtYMb8zAGxKqkpTxzQeKExwPuQRf6Y",
            rewardAmount: 26
        },
        {
            toAddress: "Eo2N2Lyu9EJFpmy7PeQzAGpHcP8UzP8KNpr8vzPaZtFM",
            rewardAmount: 24
        },
        {
            toAddress: "FAJCbj85qePSnciigsBR3cUiWS8KbwDsZhMvSVdSNAbY",
            rewardAmount: 1
        },
        {
            toAddress: "catRH4riYbGr1zi6h86BeL4QTiPJVuT9zmWsjbbdRpG",
            rewardAmount: 2
        },
        {
            toAddress: "AW5TUL4g67s7GLhCwa9xUFwVgn4THEZwsyhRMcvUWt2j",
            rewardAmount: 0.5
        },
        {
            toAddress: "ERhuVLhCqw3ZTHuBqeKfAEjVwdwuZz9t2Kg9rUsQMKg5",
            rewardAmount: 10
        },
        {
            toAddress: "6sRpzCWXnGZ4cot5p2k4suXQHgZ6CG4NxWvdyrk4wb8n",
            rewardAmount: 4
        },
        {
            toAddress: "EbzG4QigFhFb3K1QZKRMHPzvTspFVyVBNLez47aGu5y6",
            rewardAmount: 116
        },
        {
            toAddress: "2MMK2ZsYGDvFHSRbYXyYHWg4agNcuj4mzuFutMJfkvuZ",
            rewardAmount: 33
        },
        {
            toAddress: "FtZdwLEuoq1HVovNS1eeJfXXRfConvNn2He5udjBbp8C",
            rewardAmount: 104
        },
        {
            toAddress: "FrAkshpfffurLZVTp4GTZhprcK9q3bEwB5qs2ikt5yM7",
            rewardAmount: 4
        },
        {
            toAddress: "CWCGB8AYwQcLTAt3Nxa94DGvj8p8kszdqSB7VsQaCT1z",
            rewardAmount: 6
        },
        {
            toAddress: "9nW9JaHbaCrxzEsEuR2okwRsUCo4xnm1hTNLcsEgMqof",
            rewardAmount: 0.5
        },
        {
            toAddress: "EqKhsDrg2VAXxAwcNyYwr6crzhmexxWiTw8ySy4VUR7u",
            rewardAmount: 1
        },
        {
            toAddress: "6eyBRzmRX69kTVu7oEL5PhT1bUo7wxqwWRWQWaT4tmFE",
            rewardAmount: 20
        },
        {
            toAddress: "5px42vprFHoskHpEzMUrG77CXfS7hXbZxNnMu6bGgvDw",
            rewardAmount: 12
        },
        {
            toAddress: "2Pe2gwjdR5yX39jQSXi5o3qzZfBTWRFc28eFR6TyZ71T",
            rewardAmount: 22
        },
        {
            toAddress: "ExQefW5GihXRnRo9HGMMYTrCwe1BPscR1HN8etBRCz3A",
            rewardAmount: 64
        },
        {
            toAddress: "Dio5scm99Q9Uw5jCfvEZHUCc5YyqhZfDwL37zfmyHZGz",
            rewardAmount: 0.5
        },
        {
            toAddress: "Eef4P5aFkZAoudhV7qvmxYJaLuxpBLLQek6oCh4jSbrp",
            rewardAmount: 20
        },
        {
            toAddress: "HRBi9vyJavHx9qiT8XtPdFsHGmyzxTrjLkd95z23SBWb",
            rewardAmount: 49
        },
        {
            toAddress: "9VRFShBthRvbxaWVuuHxgeQv7Dz6ynpExNhgx9yBMWWv",
            rewardAmount: 6
        },
        {
            toAddress: "8fV8SBtc9XeFgzReDRRpZ5qv5kpc5992LQv1nPV9LB6S",
            rewardAmount: 20
        },
        {
            toAddress: "6o2ASdEoRGDZaaHRupBmocL7wKWNpyMXkFKePGsSs79p",
            rewardAmount: 3
        },
        {
            toAddress: "DUwAR5HovwnEttuUjwahWaE9NMXc95UuwCkD6XM4sMb5",
            rewardAmount: 85
        },
        {
            toAddress: "2C4TkYTDJy9cYdRTc9cCyKj4yHgiEVPV78hvFUeuxDDs",
            rewardAmount: 2
        },
        {
            toAddress: "9BFwP14855QAAxmZdQyCzgw6cAWjKohWBCQfRoDBSMSn",
            rewardAmount: 22
        },
        {
            toAddress: "EvSAQLY21VsB6AJAoCjYhzMtdMjdgremQihFspMmyvLR",
            rewardAmount: 5.5
        },
        {
            toAddress: "HvTnB4zY79HHV9kjnmAqhQvWJjBBB6VSULgiXpmks3HF",
            rewardAmount: 62
        },
        {
            toAddress: "5RovEqV8kh2kqD6TLVxLvenPhaiQwkGtsfLVNep45DtN",
            rewardAmount: 2.5
        },
        {
            toAddress: "BabVFTFKuZHQqWhBDaiumg95ErcsJunNHNbcW7PSaMPj",
            rewardAmount: 8.5
        },
        {
            toAddress: "Fk5boXA749zxRkAyVVh7sH8pG5v4WTiaavin9GEnqWBr",
            rewardAmount: 31
        },
        {
            toAddress: "5tEvpS64ZmYUCRzbaAGLQQS7UFFwHMuJnqM4QucW9oS3",
            rewardAmount: 20
        },
        {
            toAddress: "HpY8nFwGSX9tfkzoojxnfJTPdgVkMH216QMbj6bg3pNq",
            rewardAmount: 17
        },
        {
            toAddress: "3NKFbtbUt2QKD2De9ttG5cNcoUb6u3dLcfvRRcYW5NrL",
            rewardAmount: 93
        },
        {
            toAddress: "6P1jHnqqGdKaVtbEXcuKpAaPyMkxXXmUaNVoWrK546et",
            rewardAmount: 0.5
        },
        {
            toAddress: "CyhbEcrLHVMuDPf5L9b5gMq1DsAQ7a44CJt6rWhfJhJA",
            rewardAmount: 2.5
        },
        {
            toAddress: "Gjetn7mcuvKvAVtryWYwmJnQUPH6KVQN8WSud88h5iBU",
            rewardAmount: 23.5
        },
        {
            toAddress: "8iYiEnv4sgFPybhKgZS2QiqCAdypow8G2RTPe7a1ajbd",
            rewardAmount: 54
        },
        {
            toAddress: "3HXmjiKcj8akxpiHQdDnbFBpccRmkXmoiqUPS8eWHE1a",
            rewardAmount: 9
        },
        {
            toAddress: "aQ6QxYErYvu6z94Negc9ZsnUZSZ8f7weBwsf19KLfb9",
            rewardAmount: 5
        },
        {
            toAddress: "4x5FxG6hctG5JNaoAkiheoPG8YV7YVshXLtqXDXKNx7j",
            rewardAmount: 84
        },
        {
            toAddress: "4Mj8eDDoxrVdcXFQdu8XpFmaR942Chkub4Fpf3TKCKW2",
            rewardAmount: 126
        },
        {
            toAddress: "AZr3sQiRxTatF3L6DHypZkTFE21X1561mFxxXsQBVra",
            rewardAmount: 2.5
        },
        {
            toAddress: "75jm6FhFyfjeKQEZJFVsDMWJoMMV2P17S7X3QjcVy8Bd",
            rewardAmount: 2.5
        },
        {
            toAddress: "5HUEJfa87E3vKcj8BeT2GWcHsojKTmzfSe2XSs3pQopS",
            rewardAmount: 2
        },
        {
            toAddress: "3qLJRT7MpUZaWqSc4n2jURswPqpAicMApZ7uU3KTopdK",
            rewardAmount: 29.5
        },
        {
            toAddress: "CdpHjxSdFPKNsa95ch1EiWV5uquHs2ZyrvAmCEXc5Hss",
            rewardAmount: 4
        },
        {
            toAddress: "2dUHSczj3BqoJQCmt5YBibvkHto1LnZF29sD39JpufDP",
            rewardAmount: 2
        },
        {
            toAddress: "7jgLufH3txePdkxDyBWfBrgFUrAMpMQKy2XawrW3LsmN",
            rewardAmount: 2
        },
        {
            toAddress: "GgiAvwiBBj5FCYZzPStq3FqjPf8v2hhonwR7KVeEzwJK",
            rewardAmount: 6
        },
        {
            toAddress: "EiGq1LLukzKfRJWr1igVFTwXkBsK4ReSTLLVr5V8nSrx",
            rewardAmount: 10
        },
        {
            toAddress: "4ttyTYyvpk2XtwGMvkPKScTSKPtahaqTaYQYiDmQBnNF",
            rewardAmount: 20
        },
        {
            toAddress: "4Be9MkCvoE8JHXQRDd7atwvqqxpEzZuRCtFyUFkKEn5Z",
            rewardAmount: 1
        },
        {
            toAddress: "KnDJyja4LPejbvkvz5uzmY4VnE7AAyT9fh74rMtJrH8",
            rewardAmount: 26
        },
        {
            toAddress: "4erznN26qLKWGowvjKbKkgTTBXNRAHchjCustxGwKcbJ",
            rewardAmount: 24
        },
        {
            toAddress: "8Laq7K2LUkzcVAZyrViksTChkmYPrYWxL5UnHBWChDdi",
            rewardAmount: 2
        },
        {
            toAddress: "8pvvGG6QULusYzeT5YYAFLKFDkxBqh4y6jsuctTxz6Vm",
            rewardAmount: 8
        },
        {
            toAddress: "5oK8tNATa3sbJniX2ejsDuQ7HhfodrNp6omNU2VqY3dP",
            rewardAmount: 22
        },
        {
            toAddress: "GcaHW2TaBSJEwxqwJ3Y7XzEyY9VfJdGSrthKHnZFpEDx",
            rewardAmount: 4
        },
        {
            toAddress: "FhuS8KPQtg4qyMxfsWEDkdAo4D79t8NWxWvMD5JicRZE",
            rewardAmount: 21
        },
        {
            toAddress: "F9L6h6KQrtRHQcwfpTvo3WXT8v8GSEx42NDFznucchLK",
            rewardAmount: 42
        },
        {
            toAddress: "FpkFKAYNgKLtgaRfB8cyGs7LYhkHHFbTETWG5sNS2rA7",
            rewardAmount: 4
        },
        {
            toAddress: "B2XPBUF6YD9ftg9V8RwGzmyXWrdsWWcwvyBFu61ciBA2",
            rewardAmount: 0.5
        },
        {
            toAddress: "7tjVcKuT3N2W4GQYaShUHJ7a6fdZCDSZgmg5JVrBysic",
            rewardAmount: 0.5
        },
        {
            toAddress: "Bid62HEiRTyPi8M55j4LVeYyBCXQfyKx7375JxqVeUQh",
            rewardAmount: 34
        },
        {
            toAddress: "GQ4fzoz7UmCV13VZNGUPT3BkX4RooPKzaM1hs2XW37mz",
            rewardAmount: 52
        },
        {
            toAddress: "HmgG6D22aDuWjhcyg9BrfnyDzgezZe6DPU26ijmapsb3",
            rewardAmount: 13
        },
        {
            toAddress: "482rh5b59zo8878Yzo98am88xuohbej8nH9ZywCNJWUi",
            rewardAmount: 8
        },
        {
            toAddress: "A3FyoSLHBKchr7mVLVeiyPY7Bz1mSSEjUr8AaqBRbNap",
            rewardAmount: 4
        },
        {
            toAddress: "HNDWF2Frhkf8NTv2DT5LrWGvd9tTHjycqTowfc2u1x2P",
            rewardAmount: 48
        },
        {
            toAddress: "8xJEvtebww4asNUgDL16bjcasGBjoR4j69FtjjPVG99T",
            rewardAmount: 6
        },
        {
            toAddress: "3d5nnMvMjt3RUTtyJ9Qpjc6dw8KQTNnkEP7Zkknaqa7W",
            rewardAmount: 26
        },
        {
            toAddress: "8mcnAbXAzy34Ayf8fqqQhe1WKqYWaHZZW5rtgVh5hk8r",
            rewardAmount: 8
        },
        {
            toAddress: "CYahxGGNoefpPWYz4eS2DNZYKrs4VY2yWXk1K78S2uH",
            rewardAmount: 88
        },
        {
            toAddress: "CHfBBQBJwccZEbm5aA1fVwxbHn7gzRp5W1hdXNQom8Uf",
            rewardAmount: 0.5
        },
        {
            toAddress: "8qFtBr2L596BZbtHwoNGWjKPP71VVb4PRAGj4mJknXbu",
            rewardAmount: 2.5
        },
        {
            toAddress: "EbW5Buuu3mqqqFPukdtTnCaYd37FZtRkDhWjqQdkKScG",
            rewardAmount: 20
        },
        {
            toAddress: "8puQJpDGQWvrqkACpUsbymaZUhY9SvsAdr6u251ZTYMT",
            rewardAmount: 63
        },
        {
            toAddress: "C93SxnUwRmgGjMHFVpahjq1FARX1456F3HR8hW8roByR",
            rewardAmount: 12
        },
        {
            toAddress: "9ctqtiBYsLkYH35JMDnuYwCBcucqS7YEifwjU4HNaq97",
            rewardAmount: 2
        },
        {
            toAddress: "9Z7zaFHLw3eeiHkoShGfiFG8KuBJ9VLRznFpY6uGUit3",
            rewardAmount: 2
        },
        {
            toAddress: "FtXGvoUhFT7YwQ756sKikyStztDLEsb3s2365rcgvFp9",
            rewardAmount: 2
        },
        {
            toAddress: "Ck4SgXftFcETB4mWaSyizYtN2hZ9Qnth26BZve6WVLHg",
            rewardAmount: 4
        },
        {
            toAddress: "4JrCrACJDd5A4KrDNxhWJ9gK6J45HNtg7zXPGkV8vFRC",
            rewardAmount: 0.5
        },
        {
            toAddress: "HEy7vnGUAhH5wdd8EDzEupfM3wTDsmPRAxNyrC31k4x",
            rewardAmount: 20
        },
        {
            toAddress: "3wWysxEj4Ng63dgvypLyy2WEe6MsShdK2i3Ae6viURG5",
            rewardAmount: 4
        },
        {
            toAddress: "7QvmT3ZE4UghqAK78BC3cLuz8XTbqU8zRvgcQfCaVokZ",
            rewardAmount: 2
        },
        {
            toAddress: "7hpwNXxDjkCu2wJWaC3M9JmkEmLyGbeBNaZCBes9YPPN",
            rewardAmount: 0.5
        },
        {
            toAddress: "AKRLp54aLckSrGpMr3xdDHkXRyNUGRkr8KWWLcc3ktWA",
            rewardAmount: 2
        },
        {
            toAddress: "FgZ9cBpQbe4iDucmdQCExvgBWyAddmzN66xJX1t7FiFk",
            rewardAmount: 14
        },
        {
            toAddress: "DkRtXRLrTmKE17gewCmDSDedsVLQSfG26wMq6S9oXQUp",
            rewardAmount: 66
        },
        {
            toAddress: "8fh7z74dj7onJdSVTJEcevHSZHWSXu2pFW6TECf5maRr",
            rewardAmount: 2
        },
        {
            toAddress: "4uKLndzXYmjtyCmjA15J728ji5ZT5ZJnYZuz7fPeSpi8",
            rewardAmount: 16
        },
        {
            toAddress: "7EUz7WSdWqsGbGgvdSNS9dsjHSHCvmH69rT2zChovRsZ",
            rewardAmount: 40
        },
        {
            toAddress: "4FHrNuSKC1PHSRmCpmEpZhQ7rgoexrgYAD9hthM21XhY",
            rewardAmount: 39
        },
        {
            toAddress: "JAe8SUa7M2QbnAuVdWR4WfU7GrDsvbrmdzo3jpVxCjhC",
            rewardAmount: 2
        },
        {
            toAddress: "GZ97ExWf6u4UX2Azxfbh3jrdWTCEyWrFfsbi3NoigHpn",
            rewardAmount: 1.5
        },
        {
            toAddress: "7wu32XQyURhic5AGTkEjWoWGy7sCh8yfVMVYiV6Y6ViJ",
            rewardAmount: 16
        },
        {
            toAddress: "FWtQXZj47HZ5nSrbU6cQcWFvvfV7dT9vAoTi9TtXPYHW",
            rewardAmount: 7.5
        },
        {
            toAddress: "7UXLNddzfZWTv3zt7UHyrPc2TCSYiDB7fpeWBvbygrby",
            rewardAmount: 0.5
        },
        {
            toAddress: "BsjDg99JmcmHQacVUhtDPxwaRfpgXaQ4sMJdZweYTfV8",
            rewardAmount: 2
        },
        {
            toAddress: "BPJVn3uDifgDvmxv2iy4cPFaR663S44GAc5ZvnidrJTr",
            rewardAmount: 3.5
        },
        {
            toAddress: "CmqVZxAyJNRu9xtd8rFfuTXRx1yuC2inj4h1bSq9eF2Y",
            rewardAmount: 0.5
        },
        {
            toAddress: "D6EsdUDLUdAKWA31SppEFjniGq5y5RieQ5X7x4ChMTnJ",
            rewardAmount: 14
        },
        {
            toAddress: "BpzBFHZyN7rhiBSqWYHtwRiAGuW8MkwL5cH1WjsrSoHN",
            rewardAmount: 28
        },
        {
            toAddress: "EpAZits8iSCMUSec7mFhYqKfFMhiZKEE623EwZYeUUcY",
            rewardAmount: 14
        },
        {
            toAddress: "Br4FWEaRj95JHrZPAek5kM9pNBoRnhyvkDFgWkoZW62a",
            rewardAmount: 6
        },
        {
            toAddress: "6NLkSgkvLPsp6jZmmJtMrvGRr7XGLBgmeqFPyczbCWCz",
            rewardAmount: 22
        },
        {
            toAddress: "7ZzZW52jFLYWzKyQpcnxPJXHGVc7pZgqB86N8rvp2Jyn",
            rewardAmount: 1.5
        },
        {
            toAddress: "2MsSwTvQEURAn6KYHiCn4XJdmFutpyyBM24Zbb3nX4qA",
            rewardAmount: 6
        },
        {
            toAddress: "DikbZku9J7TWPSdvi1ZmPZZCNwy2ziWfGSXvQyKAwASQ",
            rewardAmount: 61
        },
        {
            toAddress: "9tr1r5bmXT39FHyk6PTUBu96BohWw8yxVfxU9m7qb31f",
            rewardAmount: 2
        },
        {
            toAddress: "F5Vw7k9rwy9QFtbjJdvnyJiA6Hs3bfxszeuYMDQXHQtd",
            rewardAmount: 20
        },
        {
            toAddress: "AzpBGbPTHTp6GZHEs5Bnw954WjqrNaT1CY9cJ5587Mz5",
            rewardAmount: 4
        },
        {
            toAddress: "AnrL8RwaYBEeZGnSe2dihHUJShuXzfnEXi8UzxAiGyYB",
            rewardAmount: 1.5
        },
        {
            toAddress: "7wQfWSqZPoFQ9pgbEF2gscCJKQ97sdniLU2VikjGKrF",
            rewardAmount: 2
        },
        {
            toAddress: "GA6eFo5i2wR6CF5DaPDYBqC3pVvvNPVca7YCrk1pAqxP",
            rewardAmount: 1.5
        },
        {
            toAddress: "GfDkdVAZpCD3xF7C1XqoSKVwWQPHZs12DKFqmiKjivPQ",
            rewardAmount: 20
        },
        {
            toAddress: "G9w8xTLgGZkMXnu9fbsxyQq3jZoghvVLJ24vfjUSKydA",
            rewardAmount: 2
        },
        {
            toAddress: "AEJVnZkCx2i1iGF2BeyS2aSwVnvnb6HxbGVWyLtpzyej",
            rewardAmount: 20
        },
        {
            toAddress: "YebwvfPzsm1bLahCETAyoDDgndEXCshyryzkwMeoBB7",
            rewardAmount: 14
        },
        {
            toAddress: "CfvHUxoP5nZe9zdovPRnTtyCBVx3UpooXsNCCoVucSEF",
            rewardAmount: 30
        },
        {
            toAddress: "pyd7GX49gJJ1JuKU5KJEB1En7G6VpTQcCuEBai5ebX2",
            rewardAmount: 2
        },
        {
            toAddress: "Em5M3Gb8cf8mgqHtejZXtFNrQebNabrNSNLN56L4m8W7",
            rewardAmount: 5
        },
        {
            toAddress: "BxdprTwi4sGeLpzPuDPkTQBN5T6Q4GshmxFokCks9q8",
            rewardAmount: 6
        },
        {
            toAddress: "4WqeBz2FYtdhoXcn6X1gg7gZ2nT72DD5dBi6cMUZi7yo",
            rewardAmount: 20
        },
        {
            toAddress: "5xByJbYj8zfLSB2Qkrd86yRtYYZa2MDW7C3joHhgA34D",
            rewardAmount: 10
        },
        {
            toAddress: "DhntJ1uhCzTVdj9wwYT8jCqGrxLqf7bfiwoAEPc4Anpw",
            rewardAmount: 3
        },
        {
            toAddress: "EZoHXjdmdhv5njQpNYJkLt5qpnMapSSYeHuwxRG9g6ou",
            rewardAmount: 4
        },
        {
            toAddress: "8UpeGTwiZRxuXFDohqnQHZ5De3Cq3Y3WqAnre74rRg7e",
            rewardAmount: 12
        },
        {
            toAddress: "Eh7UULksvwq3UbqxeUU1pt9JS2uGsufMgmopttFbFybT",
            rewardAmount: 1
        },
        {
            toAddress: "81XgSBbsMRrdsQ8fySisuCLzyZhrWV1FzgBS8C46prot",
            rewardAmount: 0.5
        },
        {
            toAddress: "CR7xwUKUBuSykeYqC2qW1Psm5AqUaJa6MmXKwepWLiFw",
            rewardAmount: 6
        },
        {
            toAddress: "GQPo5727rbSGHfPpwg5amffsPdMSKX9kGqQKLbdYsqUh",
            rewardAmount: 0.5
        },
        {
            toAddress: "5dgpDq9ZXBWWJ6EFYBJJDXf5ima1wJmQTSF6FtuN2ZK",
            rewardAmount: 10
        },
        {
            toAddress: "7w9VNfPCiTiSoSpfVmHtkmA1CABawEVxkS8wuXceWyA9",
            rewardAmount: 6
        },
        {
            toAddress: "4vLcnBtE4fKd3TBg9H4BqydEx416f4vxGsXs3GnSHVnq",
            rewardAmount: 6
        },
        {
            toAddress: "7weF271s52uCssNa4LTPrGWosTKvg614aqGGe5CGL5KZ",
            rewardAmount: 24
        },
        {
            toAddress: "CqLUsbTVEduFPymj1V51rjkDhEaN7ubQR71cCGfQbuVS",
            rewardAmount: 1.5
        },
        {
            toAddress: "FuaKV9ehWd95YF752uyXLVeWSZV2DMemB7SSKuKzfsGa",
            rewardAmount: 2
        },
        {
            toAddress: "5swX98pfcKCCpPGMFtopRe4eEoFZ7x35hyfaqmy8ahU9",
            rewardAmount: 2
        },
        {
            toAddress: "DjM2FKhdGiNDZ1ofmgi5yE48UseMQqrw5MALPCkXW2gn",
            rewardAmount: 6
        },
        {
            toAddress: "AAKzHWe2g2GcStKp4LnrLu1qk617byrRW1BR7wiBRutj",
            rewardAmount: 8
        },
        {
            toAddress: "3XT724yF4AgRDciPf2FVzVqN6XXMrR8F42i9UWWn5dux",
            rewardAmount: 2
        },
        {
            toAddress: "4AUZHHu6XFWKL36RzwiqLT7mcw5RiY77Egfobx4JbCpH",
            rewardAmount: 22
        },
        {
            toAddress: "8wH3fEEeraML8tykcXKsxYnp9BnDz5fsHoJ4k52rz33y",
            rewardAmount: 10
        },
        {
            toAddress: "2nxGKy5Vs47HX6jAgTm26gxd3G4yCcLDPoKr31asuVhs",
            rewardAmount: 10
        },
        {
            toAddress: "5Pi3WJUngoEaGTqwCk7eBovAu4Ycn2eFyh7qkr8wFiVw",
            rewardAmount: 1
        },
        {
            toAddress: "GTiGgZYbsjWeU4kCs8Di3DtPir5NDc9eq6vG8uSq4qJf",
            rewardAmount: 2
        },
        {
            toAddress: "EURBncuav7UXgwn2fTdfvSbvTPWYJdkcdpZZxK1YKXhK",
            rewardAmount: 18
        },
        {
            toAddress: "Dia2fHWXQG5ZfT9zGhMfKriM2QrM7K9WbMN5UdfiCjtj",
            rewardAmount: 6
        },
        {
            toAddress: "D39899LBwxXN63TbxyMF6VeGZD3fwyJttMJmKJDVbq8X",
            rewardAmount: 4.5
        },
        {
            toAddress: "HLLnnpRDfZ1pnTwNvW5tuL7waR49zgWpf5nyLtfQMk9b",
            rewardAmount: 6
        },
        {
            toAddress: "DNyTtZ8EedYRXQG5rkxdA5p1bM22vjfUVeEtxPf7ncLm",
            rewardAmount: 4
        },
        {
            toAddress: "6r8pxTYmSrBxLc1Akcf5VrfNRru6dtku25sKtNcmbhEX",
            rewardAmount: 2
        },
        {
            toAddress: "FBTuFWHcREnN8fMFLx6vy7pbhGXQJTPZHzcbQEJ1xCXB",
            rewardAmount: 16
        },
        {
            toAddress: "tBmzUbVe7HCce7BZDcP9xP1y6NhgvHEBPErXJAp9o1E",
            rewardAmount: 20
        },
        {
            toAddress: "B6YrgCCk7E56hSGMuEk56iooWS4BXRFcCfymEEgX5JTi",
            rewardAmount: 6
        },
        {
            toAddress: "2KEh2SwiimqYdBVYxLEaquditPCGjCtLQSNrqbWuhYMV",
            rewardAmount: 30
        },
        {
            toAddress: "48XdT7mRAsgqiQHURaSafmXLN8qnjWxKAPtbdjDjmh8P",
            rewardAmount: 20
        },
        {
            toAddress: "2HVbeVdJkXcwevNAyVdbAQqkv4wgEVWgUqVbhoc33NvY",
            rewardAmount: 22
        },
        {
            toAddress: "6qasrabZgKbbtjkK4aH5adKTdcxoBxUfWLV2jeQuFUKE",
            rewardAmount: 1
        },
        {
            toAddress: "DqqnYHLY8gC73CMnwmrXhNBasxbHoHGR4roRJyNJZXz1",
            rewardAmount: 1
        },
        {
            toAddress: "APGVKfBuJDuRLaXxXvQ59h1Prp5sH9F6Bjd9ybM1WBs5",
            rewardAmount: 4
        },
        {
            toAddress: "HgndtMaNQw6FGt7TGoBxB9qLbP6RdrbXsgfuWCw9Qjwg",
            rewardAmount: 14
        },
        {
            toAddress: "8AZtx55BhAgLQ2mN9hQ8MLhasQDDyRfy1Q9Jqkf76TUY",
            rewardAmount: 0.5
        },
        {
            toAddress: "CAPq195UFoigkXkCRdiuVRKRayZRqHzrPHDWHEQGDj3d",
            rewardAmount: 2
        },
        {
            toAddress: "BdkC5WHvzdxUTAwxsdyhPidotGrsdWFBw2mfXUXYpuEz",
            rewardAmount: 2
        },
        {
            toAddress: "J9m2bijKqXbvqX5jPu6Xx5m5mUKqeChzUVBHMXrQ3V3t",
            rewardAmount: 4
        },
        {
            toAddress: "4vBkNRyHxF71LKRruz4eycv5A1rRZDReM2bUtfUYaMSh",
            rewardAmount: 2
        },
        {
            toAddress: "GbVqhypP7RfqpigSQjZMTvzRHcnTjb1WUQDqiLzcB3fK",
            rewardAmount: 14
        },
        {
            toAddress: "B5MSHA3vndWKtyTctbXHSQJarGhzoEQ2shfQwedBpa7P",
            rewardAmount: 1
        },
        {
            toAddress: "Gf5xktz3RELvG6tZ54kWHEEDF7G328JnsvRN9Ei5MpFJ",
            rewardAmount: 2
        },
        {
            toAddress: "5V5mPYURZGAXnK1MsFt3uDYBHvVXCbaZ6NJUMYrNjEi6",
            rewardAmount: 44
        },
        {
            toAddress: "2iEvPyHi76omYUoajEKpRK8NGce7SKjqnR6o8GSHDuT5",
            rewardAmount: 1
        },
        {
            toAddress: "8BfFL3aobwdQCYTB5nLXc5ND4W64Teoj6AcqEWeT1yVi",
            rewardAmount: 2
        },
        {
            toAddress: "HTVxukBMwmWGjLkqis71foybp9Fd1vHzydgJj96tBBYE",
            rewardAmount: 13.5
        },
        {
            toAddress: "GDhccb2DjTkpBTGgUgyxvTHE2uJNUNYkYhyMrpQET8Mk",
            rewardAmount: 16
        },
        {
            toAddress: "DWLaueTpTYcAhVmua3ha5BrggcMfNVWGWuSkvWD4qccH",
            rewardAmount: 0.5
        },
        {
            toAddress: "GUBoo9Noih32w5RgUHxBcUhMDhQ3ZgSoaFXfuTcTJWPz",
            rewardAmount: 2
        },
        {
            toAddress: "DPrVaqYhQdC9jpY2MW3J4kVQXTo1GZ2RpEKyHQ6FFw5J",
            rewardAmount: 12
        },
        {
            toAddress: "2YTomKVPWhqm7tZNEixcvmryihXVFtp4yHjnVhDJqAZb",
            rewardAmount: 1
        },
        {
            toAddress: "8vaq2ebGPjpfwLszYvnYPJkzUtwrHAeWSPawNhLsuMW3",
            rewardAmount: 1
        },
        {
            toAddress: "5zKxWGs26JEgEeLDiYt7Qfax5CnbrQoV4ujgYWYNCRBm",
            rewardAmount: 6
        },
        {
            toAddress: "Hoy4Pys5Duoj9tuhVb2h8iaChJYiDD1BRvhFBHfn1QLN",
            rewardAmount: 4
        },
        {
            toAddress: "227VNhL1QG5M9QLq9THEztimQxHmzqVyNdwGyrQEDYHH",
            rewardAmount: 2.5
        },
        {
            toAddress: "2ovYx9vP34ixtVgBPgg3LP1EGTgmnMYD7QxCCKKzFtLx",
            rewardAmount: 0.5
        },
        {
            toAddress: "9p6HKAFAcy6NZDzPh9HDYEjbpxcrTxi5QMMAXS5CTQG4",
            rewardAmount: 0.5
        },
        {
            toAddress: "7DSdamKSBxCM5D5mG1L4rawyNv7DPk9nBpvXEbnQdxvq",
            rewardAmount: 4
        },
        {
            toAddress: "Ef5RSefkNzcHtSoTnRbCjbauBkQ2WfGu2s8NsuP5pHN4",
            rewardAmount: 14
        },
        {
            toAddress: "ELnL18FTMzgy1XUrHfdooC3PAHL9jja4gjZZf6aDWape",
            rewardAmount: 4
        },
        {
            toAddress: "56hzL1uDvhpnthoFX9DGmbrc4k6yU2ME2ADN4EZ2X3hE",
            rewardAmount: 1
        },
        {
            toAddress: "2PAbotiCVSxwoGM5T7FBo6R1K237WFKovkh392PkfFWi",
            rewardAmount: 0.5
        },
        {
            toAddress: "HKpw7CXcETTHGZbAB5J14VnnQS3bJY6vppLqQPe6KLKt",
            rewardAmount: 14
        },
        {
            toAddress: "HDuzJtEUvqerAtWLQh11UyoArQjhDCr6g7w6AD9NoiDb",
            rewardAmount: 6
        },
        {
            toAddress: "Cndn569VzsJkDSr45TZYVqToy3EQwRDUfb1JeXH53DTo",
            rewardAmount: 8
        },
        {
            toAddress: "6QtpiHYizNZHpVQ1ctE1Tggg8ErhvzghcukFYZcCdrzJ",
            rewardAmount: 4.5
        },
        {
            toAddress: "A5bq9RTocDrujw9FzUTQ7aZChzBoURsjr6ej4JsJv8Mi",
            rewardAmount: 11
        },
        {
            toAddress: "9frPLCEeKV7iJ2Bk2hQmuLShuF138k1wnbyf5q4VWGgp",
            rewardAmount: 14
        },
        {
            toAddress: "8Shmh9A5hkmyAcr3ujcTf6RbLcG8ipwGFTES7sSFUj8m",
            rewardAmount: 2
        },
        {
            toAddress: "5wGHA5Frxi7vv5EmwNMvUnKZDEshqutXHGUwPm3k4oYs",
            rewardAmount: 6
        },
        {
            toAddress: "BXQ2tCD2iGjopPLxqiYaCmts5USdkJg1RFeWWC4QAKS7",
            rewardAmount: 4
        },
        {
            toAddress: "AiKXKGzw7bFMJ4d5jLr3q6HRBXB87aePshAVT1GkEtsZ",
            rewardAmount: 14
        },
        {
            toAddress: "EcjkhUpK5PArEL5iN3hUqGa6WBwfgxtuSLDPRFiGTiTh",
            rewardAmount: 1
        },
        {
            toAddress: "6RBnZy3SYAofP2Cjo7kL3HYYwnn2DGYuarqUePRN3TyV",
            rewardAmount: 4
        },
        {
            toAddress: "H15Bc3fVyaXsEFSyytqAMGmsEeFPJKxaYcze5srsuMJu",
            rewardAmount: 1
        },
        {
            toAddress: "8sRf7fYYpwv9XSYwbxA8NcFgT82EvYYR2qwv8hVKhz4n",
            rewardAmount: 4
        },
        {
            toAddress: "633AvtkCZJ5W7LYST6ADDsSTMEzc5fxEgdUNhc13aLdE",
            rewardAmount: 2
        },
        {
            toAddress: "9rnHKyUygYfdjoQXDQYrtJHPCe19BPkgVUDJD2JnLp84",
            rewardAmount: 2
        },
        {
            toAddress: "CrtnEFvmPtvuDbvYCTDxKF1zobhjyM73nDZLV5EsqJva",
            rewardAmount: 2
        },
        {
            toAddress: "FAmH6N4bR8iNPrry7FaifUCWXmoq6zrEwVMQHgU5qyhF",
            rewardAmount: 2
        },
        {
            toAddress: "7RbGrC6qyxdEU5MLUaSV1oQCSyXq3Q7wsTLkArWobuPi",
            rewardAmount: 2
        },
        {
            toAddress: "BJzfrrCyMwfUFvJqUrXjcQyEwJrXqAjLCTVwFEaEC59B",
            rewardAmount: 10
        },
        {
            toAddress: "CJiEDQPhGC2fHQkq81t8EtU9WMjcbNPB8odQuRR4XuVm",
            rewardAmount: 2
        },
        {
            toAddress: "4TR8xshLKFnYRzphteXjQgvuh8xjvrQ8vHHet1TP3Mqb",
            rewardAmount: 2
        },
        {
            toAddress: "n2Cs93T6oo1nHHLNf8FDnufDkw5WUqiYD3u5hXkufAT",
            rewardAmount: 10
        },
        {
            toAddress: "92R8vmDxnRPNKpQZ2ugmvvtxhwvpbeHK5bdHJnjkQTgT",
            rewardAmount: 2
        },
        {
            toAddress: "7azqm8HWqiqZPrcgWoBbtNc9HykxpzK5zGTuiJXkpzNZ",
            rewardAmount: 3
        },
        {
            toAddress: "Eu96WCkhQ97jkyS1SJgTzxRKkL6mdfRjaNUamMNjd2Bh",
            rewardAmount: 2
        },
        {
            toAddress: "FS7o675HAXoT7Dc5wwkRtp4UNeGnKLgDR5sP17cJ8vr5",
            rewardAmount: 2
        },
        {
            toAddress: "4C9tFCcFoofygS53t5iyTfNKABvAY1imcyTJtEEyqAMc",
            rewardAmount: 6
        },
        {
            toAddress: "9zB9Uw33BcpupNJUfn7FxKnVpoZUkhTxuNkkMmPRvFZU",
            rewardAmount: 2
        },
        {
            toAddress: "67rnteVPPNdz6bhf1vd9y11ASJAMh55JvQQDaNCKKtnf",
            rewardAmount: 10
        },
        {
            toAddress: "Ct8evmH4cbZDyt61xdxB77cZUhJ592o484Y4jqCjo1aE",
            rewardAmount: 2
        },
        {
            toAddress: "5HCS4s7bvuzCkKa84e2aRGJtF3o2G75xvgRRRmShP2YZ",
            rewardAmount: 2
        },
        {
            toAddress: "d7q7rTMeZQJcydmttUcH5n8U3tMY8gXM6DJkvnMugn6",
            rewardAmount: 1
        },
        {
            toAddress: "3xiqSqH7X5rquRBDkdXC7JRBALTTa67GGFHqhDyvt8N5",
            rewardAmount: 2
        },
        {
            toAddress: "FLgd8KbhhcKcphPMqJiWSiLkYGbFWnmizakwwszQHUAE",
            rewardAmount: 2.5
        },
        {
            toAddress: "4xVP4MXu2KA3bHFJztdHyA38mh6Y8kviULEsM2deovXX",
            rewardAmount: 2
        },
        {
            toAddress: "E8jhBSBcZAAh5LU8JdLDp9nngcXTHkvBCwixpeSqtnsk",
            rewardAmount: 2
        },
        {
            toAddress: "H8Pn8minEzy99QCXo35nKZH7FSbXE2EJo2rjo518pXjL",
            rewardAmount: 0.5
        },
        {
            toAddress: "EhuYcAGkLgR9nqFaakSDSbLNqGyr67Tu8hNqdaXJ14ir",
            rewardAmount: 2
        },
        {
            toAddress: "4FWnfV3WKdsV14f6ZzDa8LqsUFkjp843cbFgai3BNhnw",
            rewardAmount: 0.5
        },
        {
            toAddress: "8aKEJRhXrTzkiea8zVQR27ugLzVJdafRh7RKoEvKepgF",
            rewardAmount: 4
        },
        {
            toAddress: "2ptTVTYq2dhdShNjoj5bkqJsZCdekKzDwezd1Jvdu4zx",
            rewardAmount: 14
        },
        {
            toAddress: "FhmduyBVqEa7zJc3tXt9cq1Z9B1RrA39mKaWjGSBdhGz",
            rewardAmount: 2
        },
        {
            toAddress: "3kifLX3DdykP2qK3TQuzLLsbkYswnoGVC1bUYoTkxQDR",
            rewardAmount: 2
        },
        {
            toAddress: "FQ6zE9kfAq1tuQsZ5juRTdLrNa7ophomp5miUmneXovj",
            rewardAmount: 0.5
        },
        {
            toAddress: "5skwj6Z34JbA4S6qTDVYJbddtbxk28JHdQsDr4rDBDJr",
            rewardAmount: 2
        },
        {
            toAddress: "4psftUqtnndK77JTSjyvBz7sEMRFjjqi2VL3WBZNByXz",
            rewardAmount: 4
        },
        {
            toAddress: "5Xrpc8N6ptrFW4SEV9MEp8581FBUFGuhQbUDJ2Q2zjeY",
            rewardAmount: 14
        },
        {
            toAddress: "Gp69PMaucWQH71k8f5BgYPwwcGWgccZ9FLoXzDVecjms",
            rewardAmount: 0.5
        },
        {
            toAddress: "CPuxA8Cdwx7vGRG9cmpZAZrXCAMaRmES65XYpnw6aMpP",
            rewardAmount: 2
        },
        {
            toAddress: "7T4AZRrp2gW4RuJGVwEJC3kwQj3V4XRJcPExoy7ii84x",
            rewardAmount: 0.5
        },
        {
            toAddress: "DQTjMV1Qgoud7QADViksEyitey17eXbuUk7zexofzirw",
            rewardAmount: 2
        },
        {
            toAddress: "BDMH8chjEtkfW1VMndPJn1RsKgLshRykTACfSXGU8oCc",
            rewardAmount: 2
        },
        {
            toAddress: "9ckm93ih8diVoewymKeefjtrgjsdtVPd96LKEgsQEr6L",
            rewardAmount: 2
        },
        {
            toAddress: "ANjKZnHcWHpixQdmyrwDTswnsPU1pf311LrDtm4A3WV2",
            rewardAmount: 2
        },
        {
            toAddress: "BbHywMrwaC9keVKCpMHjaU6w2uo1aXmpugZWAnSfFNny",
            rewardAmount: 2
        },
        {
            toAddress: "9WcMZJihLjvs2qEMwJKdPAG7TMTtVPdhdE6YyNvPUBMd",
            rewardAmount: 2
        },
        {
            toAddress: "55PHVyBBaMQhtRZKj6k1Sp3gjJcJtByZdn2isfocYqq6",
            rewardAmount: 2
        }
    ]
    currentRewardAmounts = stakeholdersRewards
 

    const signatures = []
    rewardedStakeholders = 0
    for (let i = 0; i < stakeholdersRewards.length; i++) {
        const signature = await transferReward(stakeholdersRewards[i].toAddress, stakeholdersRewards[i].rewardAmount)
        rewardedStakeholders++;
        if (signature) {
            signatures.push(signature)
            console.info(`${i + 1}/${stakeholdersRewards.length}: Transferred ${stakeholdersRewards[i].rewardAmount} reward tokens to ${stakeholdersRewards[i].toAddress}`)
        }
    }
    airdropActive = false
    console.log('<<<<>>>>>ALL TRANSACTIONS SUCCESSFULL<<<<>>>>>')
}

// CRON JOB CONFIGURATION
// cron.schedule("00 00 07 * * *", async () => {
//     console.info(`<<<<<-----AIRDROP PROCEDURE INITIATING----->>>>>`)
//     await airdrop()
//     let time = new Date()
//     lastAirdropTime = time
//     console.info(`<<<<<-----SUCCESSFULL AIRDROP COMPLETED----->>>>>`)
//     console.info(`<<<---DATE: ${time}--->>>`)
//     console.log(`<<<<<-----PLEASE WAIT FOR NEXT AIRDROP----->>>>>`)
// })
cron.schedule("00 10 11 * * *", async () => {
    console.info(`<<<<<-----AIRDROP PROCEDURE INITIATING----->>>>>`)
    await airdrop()
    let time = new Date()
    lastAirdropTime = time
    console.info(`<<<<<-----SUCCESSFULL AIRDROP COMPLETED----->>>>>`)
    console.info(`<<<---DATE: ${time}--->>>`)
    console.log(`<<<<<-----PLEASE WAIT FOR NEXT AIRDROP----->>>>>`)
})
app.get("/api/airdrop", async (req, res) => {
    res.send({
        airdropActive: airdropActive,
        msg: "The server is running! Next airdrop will happen at 7AM UTC",
        lastAirdrop: lastAirdropTime,
        totalStakeholdersCount: totalStakeholders,
        stakeholdersInfo,
        rewardCalculationsDone: currentRewardAmounts.length,
        rewardTransactionsCompleted: rewardedStakeholders,
        currentRewardCount: currentRewardAmounts,
        failedTransactions: failedStakeholders,
        numOfFailedTransactions: failedStakeholders.length
    })
})

// SERVER LISTENING
const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
    console.log('Server is running successfully on Port: ' + PORT)
})

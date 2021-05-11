import { Router } from 'express';

import { apiStatus, getCurrentStoreView, getCurrentStoreCode } from '../../../lib/util';
import { getClient as getElasticClient, adjustQuery, getHits } from '../../../lib/elastic';
import slugify from 'slugify';

const { SitemapStream, streamToPromise } = require('sitemap')
const { createGzip } = require('zlib')
const { Readable } = require('stream')
const bodybuilder = require('bodybuilder')

let sitemap

module.exports = ({ config, db }) => {
  const getStockList = (storeCode) => {
    let storeView = getCurrentStoreView(storeCode)
    const esQuery = adjustQuery({
      index: storeView.elasticsearch.index, // current index name
      body: bodybuilder().size(10000).build()
    }, 'product', config)

    return getElasticClient(config).search(esQuery).then((products) => { // we're always trying to populate cache - when online
      console.log(products.body.hits.hits.length)

      return getHits(products).map(el => ({
        name: el._source.name,
        sku: el._source.sku,
        ...el._source
      }))
    }).catch(err => {
      console.error(err)
    })
  }

  const getCategoriesList = (storeCode) => {
    let storeView = getCurrentStoreView(storeCode)
    const esQuery = adjustQuery({
      index: storeView.elasticsearch.index, // current index name
      body: bodybuilder().size(10000).build()
    }, 'category', config)

    return getElasticClient(config).search(esQuery).then((categories) => { // we're always trying to populate cache - when online
      return getHits(categories).map(el => ({
        ...el._source
      }))
    }).catch(err => {
      console.error(err)
    })
  }

  let cmsApi = Router();

  cmsApi.get('/sitemap', async (req, res) => {
    res.header('Content-Type', 'application/xml');
    res.header('Content-Encoding', 'gzip');
    // if we have a cached entry send it
    if (sitemap) {
      res.send(sitemap)
      return
    }

    try {
      const smStream = new SitemapStream({ hostname: 'https://klushki22.ru/' })
      const pipeline = smStream.pipe(createGzip());

      const categories = await getCategoriesList(getCurrentStoreCode(req));

      categories.forEach(item => {
        smStream.write({ url: `/c/${item.slug}`, changefreq: 'daily' });
      });

      const result = await getStockList(getCurrentStoreCode(req));

      result.forEach(item => {
        const slug = slugify(item.name) + '-' + item.id;
        if (item.configurable_children) {
          item.configurable_children.forEach(child => {
            smStream.write({ url: `/p/${item.sku}/${slug}/${child.sku}`, changefreq: 'daily' });
          })
        }
      });

      // cache the response
      streamToPromise(pipeline).then(sm => sitemap = sm)
      // make sure to attach a write stream such as streamToPromise before ending
      smStream.end()
      // stream write the response
      pipeline.pipe(res).on('error', (e) => { throw e })
    } catch (e) {
      console.error(e)
      apiStatus(res, err, 500);
    }
  })

  return cmsApi
}

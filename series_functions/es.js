var _ = require('lodash');
var moment = require('moment');
var toMS = require('../lib/to_milliseconds.js');
var Datasource = require('../lib/classes/datasource');

function createDateAgg(config, tlConfig) {
  var dateAgg = {
    time_buckets: {
      meta: {type: 'time_buckets'},
      date_histogram: {
        field: config.timefield,
        interval: config.interval,
        time_zone: tlConfig.time.timezone,
        extended_bounds: {
          min: tlConfig.time.from,
          max: tlConfig.time.to
        },
        min_doc_count: 0
      }
    }
  };

  dateAgg.time_buckets.aggs = {};
  _.each(config.metric, function (metric, i) {
    var metric = metric.split(':');
    if (metric[0] === 'count') {
      // This is pretty lame, but its how the "doc_count" metric has to be implemented at the moment
      // It simplifies the aggregation tree walking code considerably
      dateAgg.time_buckets.aggs[metric] = {
        bucket_script: {
          buckets_path: '_count',
          script: {inline: '_value', lang: 'expression'}
        }
      };
    } else if (metric[0] && metric[1]) {
      var metricName = metric[0] + '(' + metric[1] + ')';
      dateAgg.time_buckets.aggs[metricName] = {};
      dateAgg.time_buckets.aggs[metricName][metric[0]] = {field: metric[1]};
    } else {
      throw new Error ('`metric` requires metric:field or simply count');
    }
  });

  return dateAgg;
}

function buildRequest(config, tlConfig) {

  var bool = {must: [], must_not: []};

  if (config.kibana) {
    var kibanaFilters = _.get(tlConfig, 'request.payload.extended.es.filters') || [];
    bool.must = _.chain(kibanaFilters).filter(function (filter) {return !filter.meta.negate;}).pluck('query').values();
    bool.must_not = _.chain(kibanaFilters).filter(function (filter) {return filter.meta.negate;}).pluck('query').values();
  }

  var timeFilter = {range:{}};
  timeFilter.range[config.timefield] = {gte: tlConfig.time.from, lte: tlConfig.time.to, format: 'epoch_millis'};
  bool.must.push(timeFilter);

  var searchRequest = {
    index: config.index,
    body: {
      query: {
        bool: {
          must: [{
            query_string: {
              query: config.q
            }
          }],
          filter: {
            bool: bool
          }
        }
      },
      aggs: {
        time_buckets: {
          date_histogram: {
            field: config.timefield,
            interval: config.interval,
            time_zone: tlConfig.time.timezone,
            extended_bounds: {
              min: tlConfig.time.from,
              max: tlConfig.time.to
            },
            min_doc_count: 0
          }
        }
      },
      aggs: {}
    }
  };

  searchRequest.body.aggs.time_buckets.aggs = {};

  _.each(config.metric, function (metric, i) {
    var metric = metric.split(':');
    if (metric[0] === 'count') {
      // This is pretty lame, but its how the "doc_count" metric has to be implemented at the moment
      // It simplifies the aggregation tree walking code considerably
      searchRequest.body.aggs.time_buckets.aggs[metric] = {
        bucket_script: {
          buckets_path: '_count',
          script: {inline: '_value', lang: 'expression'}
        }
      };
    } else if (metric[0] && metric[1]) {
      searchRequest.body.aggs.time_buckets.aggs[metric] = {};
      searchRequest.body.aggs.time_buckets.aggs[metric][metric[0]] = {field: metric[1]};
    } else {
      throw new Error ('`metric` requires metric:field or simply count');
    }
  });

  _.assign(aggCursor, createDateAgg(config, tlConfig));



  return {
    index: config.index,
    body: {
      query: {
        bool: bool
      },
      aggs: aggs,
      size: 0
    }
  };
}

module.exports = new Datasource('es', {
  args: [
    {
      name: 'q',
      types: ['string', 'null'],
      multi: true,
      help: 'Query in lucene query string syntax'
    },
    {
      name: 'metric',
      types: ['string', 'null'],
      multi: true,
      help: 'An elasticsearch single value metric agg, eg avg, sum, min, max or cardinality, followed by a field.' +
        ' Eg "sum:bytes", or just "count"'
    },
    {
      name: 'split',
      types: ['string', 'null'],
      multi: true,
      help: 'An elasticsearch field to split the series on and a limit. Eg, "hostname:10" to get the top 10 hostnames'
    },
    {
      name: 'index',
      types: ['string', 'null'],
      help: 'Index to query, wildcards accepted'
    },
    {
      name: 'timefield',
      types: ['string', 'null'],
      help: 'Field of type "date" to use for x-axis'
    },
    {
      name: 'kibana',
      types: ['boolean', 'null'],
      help: 'Respect filters on Kibana dashboards. Only has an effect when using on Kibana dashboards'
    },
    {
      name: 'interval', // You really shouldn't use this, use the interval picker instead
      types: ['string', 'null'],
      help: '**DO NOT USE THIS**. Its fun for debugging fit functions, but you really should use the interval picker'
    },
    {
      name: 'url',
      types: ['string', 'null'],
      help: 'Elasticsearch server URL, eg http://localhost:9200'
    }
  ],
  help: 'Pull data from an elasticsearch instance',
  aliases: ['elasticsearch'],
  fn: function esFn(args, tlConfig) {

    var config = _.defaults(_.clone(args.byName), {
      q: '*',
      metric: ['count'],
      index: tlConfig.file.es.default_index,
      timefield: tlConfig.file.es.timefield,
      interval: tlConfig.time.interval,
      kibana: true,
      url: tlConfig.file.es.url,
      fit: 'nearest'
    });

    if (!tlConfig.file.es.allow_url_parameter && args.byName.url) {
      throw new Error('url= is not allowed');
    }

    var callWithRequest = tlConfig.server.plugins.elasticsearch.callWithRequest;

    var body = buildRequest(config, tlConfig);

    function aggResponseToSeriesList(aggs) {
      var timestamps = _.pluck(aggs.time_buckets.buckets, 'key');

      var series = {};
      _.each(aggs.time_buckets.buckets, function (bucket) {
        _.forOwn(bucket, function (val, key) {
          if (_.isPlainObject(val)) {
            series[key] = series[key] || [];
            series[key].push(val.value);
          }
        });
      });

      return _.map(series, function (values, name) {
        return {
          data: _.zip(timestamps, values),
          type: 'series',
          fit: config.fit,
          label: config.q + '/' + name
        };
      });
    }

    return callWithRequest(tlConfig.request, 'search', body).then(function (resp) {
      if (!resp._shards.total) throw new Error('Elasticsearch index not found: ' + config.index);

      return {
        type: 'seriesList',
        list: aggResponseToSeriesList(resp.aggregations)
      };
    });
  }
});

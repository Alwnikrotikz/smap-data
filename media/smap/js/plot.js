// -*- java -*-

var datefmt = "%W %M %e, %z %H:%i:00";
var page_args = getUrlVars();

// the current stream's offset from UTC
var tz = 0;

// normally we want to repect the user's settings, but when
// initializing pick defaults.
var initializing = true;
var pending_loads = 0;
var last_render = 0;

var plot_data = {};

function plotInit (no_create) {
  // set up a reasonable range by default
  if (initializing && "start" in page_args && "end" in page_args) {
    var then = new Date(page_args["start"] * 1);
    var now = new Date(page_args["end"] * 1);
  } else {
    var now = new Date();
    var then = new Date(now.getTime() - (3600 * 24 * 1000));
  }
  var converter = new AnyTime.Converter( { format: datefmt });
  document.getElementById("startDate").value = converter.format(then);
  document.getElementById("endDate").value = converter.format(now);
  if (!no_create) {
    AnyTime.picker( "startDate", 
    { format: datefmt, firstDOW: 0 } );
    AnyTime.picker( "endDate", 
    { format: datefmt, firstDOW: 0 } );  
  }

  if ("stack" in page_args) {
    document.getElementById("stack").checked = !(page_args["stack"] == "false");
  }
}


// return the currently selected time range
function getTimeRange() {
  var start = new Date(document.getElementById("startDate").value);
  var end = new Date(document.getElementById("endDate").value);

  if (initializing && "start" in page_args) {
    start = page_args["start"]
  } else {
    start = Math.round(start.getTime() );
  }
  if (initializing && "end" in page_args) {
    end = page_args["end"];
  } else {
    end = Math.round(end.getTime());
  }
  initializing = false;
  return [start, end];
}

// change the dates in the data series "data" to be in timezone "tz".
// should be a zoneinfo timezone; this is for flot so the display ends
// up right.
function mungeTimes(data, tz) {
  if (data.length == 0) return;
  var point = new timezoneJS.Date();
  point.setTimezone(tz);
  point.setTime(data[0][0]);
  var offset = point.getLocalOffset();
  for (i = 0; i < data.length; i++) {
    data[i][0] -= offset * 60 * 1000;
  }
}

// render an html description of the tags for a stream
function makeTagTable(obj) {
  var descr = "<table class=\"tag_table\" id=\"" + obj["uuid"] + "\">";
  var keys = [];
  if ("Description" in obj) {
    descr += "<tr><th colspan=2 style=\"text-align: left\">" + obj["Description"] + "</th></tr>";
  }
  for (var key in obj) {
    if (key != "ValidTime") {
      keys.push(key);
    }
  }
  keys.sort();
  for (var idx in keys) {
    var off = 0;
    var key = keys[idx];
    descr += "<tr><td>" + key + "</td><td>" + obj[key] + "</td></tr>";
  }
  descr += "</table>";
  return $(descr);
}

// add a stream to the current plot
function addStream(streamid, labels) {
  for (var i = 0; i < labels.length; i++) { 
    labels[i] = labels[i].replace(/__/g, "/"); 
  }
  plot_data[streamid] = {
    "data" : [],
    "seriesLabel" : labels,
    "yaxis" : -1,
  };
  updateMeta(streamid);
}

function delStream(streamid) {
  if (streamid in plot_data) {
    delete plot_data[streamid];
    updateLegend();
    updatePlot();
  }
}

function plotterClearPlot() {
  plot_data = {};
  updateLegend();
  updatePlot();
}

function chooseAxis(streamid) {
  var y1used = false;
  plot_data[streamid]["yaxis"] = -1;

  for (sid in plot_data) {
    if (sid == streamid)
      continue;
    if (!("tags" in plot_data[sid]))
      continue;
    y1used = true;

    if (plot_data[streamid]["tags"]["Properties"]["UnitofMeasure"] ==
        plot_data[sid]["tags"]["Properties"]["UnitofMeasure"]) {
      plot_data[streamid]["yaxis"] = plot_data[sid]["yaxis"];
    }
  }
  if (plot_data[streamid]["yaxis"] == -1) {
    plot_data[streamid]["yaxis"] = (y1used) ? 2 : 1;
  }
}

// load the metadata for streamid "streamid" and plot
function updateMeta(streamid) {
  $.get(url + "/backend/api/tags/uuid/" + streamid,
        function(data) {
          var obj = eval(data)[0];
          plot_data[streamid]['tags'] = obj;
          plot_data[streamid]['label'] = obj['uuid'];          
          if (plot_data[streamid]["yaxis"] == -1)
            chooseAxis(streamid);

          loadData(streamid);
        });
}

// reload all data for all series
function reloadData() {
  for (var streamid in plot_data) {
    loadData(streamid);
  }
}

// called when the time range changes -- reload all data for a single stream
function loadData(streamid) {
  var range = getTimeRange();
  var start = range[0], end = range[1];

  var query = "/backend/api/data/uuid/" + escape(streamid) +
    "?starttime=" + escape(start) + 
    "&endtime=" + escape(end);

  var startLoadTime = new Date();
  pending_loads ++;
  $.get(query, 
        function() {
          var streamid_ = streamid;
          return function(resp) {
            var endLoadTime = new Date();
            var data = eval(resp);
            console.log("response was " + resp.length + " bytes");
            data = data[0]['Readings'];
            plot_data[streamid_]['data'] = data;
            if (data.length > 0) {
              plot_data[streamid_]['latest_timestamp'] = data[data.length - 1][0];
              mungeTimes(data, plot_data[streamid_]["tags"]["Properties"]["Timezone"]);
              plot_data[streamid_]['tags']['LoadTime'] = (endLoadTime - startLoadTime) + 
                "ms, " + data.length + " points";
              updateLegend();
              pending_loads--;
              updatePlot();
            } else {
              pending_loads--;
              plot_data[streamid_]['latest_timestamp'] = undefined;
            }
          }
        }());
  return;
}

function makeToggleFn(eltid) {
  return function() {
    $("#" + eltid).toggle();
    if ($("#" + eltid).is(":visible")) {
      $("#more_" + eltid).button({
        icons: { secondary: "ui-icon-triangle-1-n" },
        label: "Less"});
    } else {
      $("#more_" + eltid).button({
        icons: { secondary: "ui-icon-triangle-1-s" },
        label: "More"});
    }
  };
}

function makeAxisFn(eltid) {
  return function() {
    plot_data[eltid]["yaxis"] = 
      $("input:radio[name=axis_" + eltid + "]:checked").val();
  }
}

function updateLegend() {
  $("#description").empty();
  var range = getTimeRange();
  var start = range[0], end = range[1];
  var sArray = [];
  var i = 0;
  for (var streamid in plot_data) {
    sArray.push(streamid);
    if (!("tags" in plot_data[streamid])) continue;
    var div = $("<div class=\"legend_item\"></div>");
    var label_pieces = [];
    tags = flatten(plot_data[streamid]['tags']);
    for (var j = 0; j < plot_data[streamid]["seriesLabel"].length; j++) {
      label_pieces.push(tags[plot_data[streamid]["seriesLabel"][j]]);
    }
    var y1checked = plot_data[streamid]["yaxis"] == 1 ? "checked" : "";
    var y2checked = plot_data[streamid]["yaxis"] == 2 ? "checked" : "";
    
    div.append("<div class=\"series_color\" style=\"background-color: " + 
                             colormap[i++] + "\"></div><div class=\"series_label\">" + 
                             "<button id=\"remove_" + streamid + "\">No Text</button>   " +
                             "<button id=\"hide_" + streamid + "\"/>   " +
                             "<span id=\"axis_" + streamid + "\" >" +
                               "<input type=\"radio\" id=\"axis_y1_" + streamid + "\" name=\"axis_" + 
                                      streamid +  "\" value=\"1\" " + y1checked + "/>" +
                               "<label for=\"axis_y1_" + streamid + "\">y1</label>" +
                               "<input type=\"radio\" id=\"axis_y2_" + streamid + "\" name=\"axis_" + 
                                      streamid + "\" value=\"2\" " + y2checked + "/>" +
                                 "<label for=\"axis_y2_" + streamid + "\">y2</label>" +
                             "</span>" +
                             "<button id=\"more_" + streamid + "\"/>   " +
                             "<a href=\"/backend/api/data/uuid/" + streamid + 
                                "?format=csv&tags=" + "\">[csv]</a>    " + 
                             label_pieces.join(" :: ") + 
                             "</div>");
    div.append(makeTagTable(tags));
    div.append("<div style=\"clear: left; margin: 12px;\"></div>");
    $("#description").append(div);

    $("#axis_" + streamid).buttonset();
    $("#axis_" + streamid).click(makeAxisFn(streamid));
    $("#more_" + streamid).button({
      icons: { secondary: "ui-icon-triangle-1-s" },
      label: "More"});
    $("#more_" + streamid).click(makeToggleFn(streamid));
    $("#hide_" + streamid).button({
      label: plot_data[streamid]["hidden"] ?
               "Show" : "Hide"});
    $("#hide_" + streamid).click(function() {
      var streamid_ = streamid;
      return function() { 
        plot_data[streamid_]["hidden"] = plot_data[streamid_]["hidden"] ? false : true;
        $("#hide_" + streamid_).button({label: plot_data[streamid_]["hidden"] ?
                                                 "Show" : "Hide"});
        updatePlot();
        return false;
      };
    }());
    $("#remove_" + streamid).button({
      icons: { primary: "ui-icon-closethick" }, text: false});
       $("#remove_" + streamid).click(function () {
         var streamid_ = streamid;
         return function () { delStream(streamid_); };
       }());
    
    $("#" + streamid).hide();
  }
  document.getElementById("permalink").href = 
    "/plot/" + "?streamids=" + sArray.join(',') + 
    "&start=" + start + "&end=" + end +
    "&stack=" + document.getElementById("stack").checked;
}

function updateAxisLabels() {
  var xunits = [];
  var yunits = [[], []];
  for (var streamid in plot_data) {
    xunits.push(plot_data[streamid]['tags']['Properties']['Timezone']);
    yunits[parseInt(plot_data[streamid]['yaxis']) - 1]
      .push(plot_data[streamid]['tags']['Properties']['UnitofMeasure']);
  }

  document.getElementById("xaxisLabel").innerHTML =
    "Reading Time (" + $.unique(xunits).join(", ") + ")";
  document.getElementById("yaxisLabel").innerHTML = $.unique(yunits[0]).join(", ");
  document.getElementById("yaxis2Label").innerHTML = $.unique(yunits[1]).join(", ");
}

function updatePlot() {
  var ddata = [];
  var now = (new Date()).getTime();
  if (pending_loads > 0 && 
      now - last_render < 2000) return;
  last_render = now;
  for (var streamid in plot_data) {
    if (plot_data[streamid]["hidden"]) {
      ddata.push([]);
      continue;
    }
    ddata.push({
        "data": plot_data[streamid]["data"],
        "stack" : document.getElementById("stack").checked ? true : null,
        "shadowSize" : 0,
        "yaxis" : parseInt(plot_data[streamid]["yaxis"]),
      });
  }
  
  $("#chart_div").empty();
  if (ddata.length == 0) {
    $("#yaxisLabel").empty();
    updateLegend();
  }

  updateAxisLabels();
  var plot = $.plot($("#chart_div"), 
         ddata,
         {
           "xaxes" : [{
             "mode" : "time",
            }],
           "yaxes" : [ {}, {
               "position" : "right"
             }],
            lines: {
              fill: document.getElementById("stack").checked,
               lineWidth: 1,
            },
            // use matlab's colormap(lines)
            colors: colormap,
//             zoom : {
//              interactive: false,
//             },
//             pan : {
//              interactive: false,
//             },
//             selection : {
//               mode: "xy"
//             },
         });

    // add zoom out button
//    $('<div class="zoomout">zoom out</div>').appendTo($("#chart_div")).click(function (e) {
//         e.preventDefault();
//         plot.zoomOut();
//     });
//    $('<div class="zoomout">zoom in</div>').appendTo($("#chart_div")).click(function (e) {
//         e.preventDefault();
//         plot.zoomIn();
//     });
}


function setEndNow() {
  var converter = new AnyTime.Converter( { format: datefmt });
  document.getElementById("endDate").value = converter.format(new Date());
}

function trimWindow() {
  var window = getTimeRange();
  var min_point;
  var max_point = 0;

  for (var streamid in plot_data) {
    max_point = (plot_data[streamid]["latest_timestamp"] > max_point) ?
      plot_data[streamid]["latest_timestamp"] : max_point;
  }
  min_point = max_point - (window [1] - window[0]);
  // advance the date controls, keeping the window size the same
  document.getElementById("startDate").value = new Date(min_point);
  document.getElementById("endDate").value = new Date(max_point);
  for (var streamid in plot_data) {
    var i;
    var window_filter = [[min_point]];
    // move the new data into the proper timezone
    mungeTimes(window_filter, plot_data[streamid]["Properties/Timezone"]);
    for (i = 0; i < plot_data[streamid]["data"].length; i++) {
      if (plot_data[streamid]["data"][i][0] >= window_filter[0][0])
        break;
    }
    if (i > 0) {
      // remove the part of the series before the window
      plot_data[streamid]["data"].splice(0, i);
    }
  }  
}

function autoUpdatePoll() {
  setTimeout(autoUpdatePoll, 1000);
  if (!$("#autoupdate").is(":checked")) return;
    
  for (var streamid in plot_data) {
    if (!(plot_data[streamid]["latest_timestamp"])) continue;
    var query = "/backend/api/data/uuid/" + escape(streamid) + 
      "?starttime=" + escape(plot_data[streamid]["latest_timestamp"]) + 
      "&direction=next&limit=10000";
    $.get(query, function () {
        var streamid_ = streamid;
        return function(resp) {
          var data = eval(resp);
          data = data[0]['Readings'];
          if (!(streamid_ in plot_data)) return;
          if (data.length <= 0) return;
          plot_data[streamid_]["latest_timestamp"] = data[data.length - 1][0];
          mungeTimes(data, plot_data[streamid_]["tags"]["Properties"]["Timezone"]);
          plot_data[streamid_]['data'].push.apply(plot_data[streamid_]['data'], data);
          trimWindow();
          updatePlot();
        }
      }());
  }
}
setTimeout(autoUpdatePoll, 1000);